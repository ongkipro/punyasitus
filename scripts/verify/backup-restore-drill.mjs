#!/usr/bin/env node
/* global process, console, Buffer */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { splitMigrationStatements } from "../../packages/db/src/connections/sql-splitter.ts";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "../..");
const RTO_BUDGET_MS = 4 * 60 * 60 * 1000; // 4 hours per docs/operations/backup-restore.md

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function formatSqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex").toUpperCase()}'`;
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

function normalizeCreateDdl(ddl) {
  const trimmed = ddl.trim().replace(/;+\s*$/, "");
  if (/^CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(trimmed)) {
    return trimmed.replace(/^CREATE\s+TABLE\s+/i, "CREATE TABLE IF NOT EXISTS ");
  }
  if (/^CREATE\s+UNIQUE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(trimmed)) {
    return trimmed.replace(/^CREATE\s+UNIQUE\s+INDEX\s+/i, "CREATE UNIQUE INDEX IF NOT EXISTS ");
  }
  if (/^CREATE\s+INDEX\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(trimmed)) {
    return trimmed.replace(/^CREATE\s+INDEX\s+/i, "CREATE INDEX IF NOT EXISTS ");
  }
  if (/^CREATE\s+TRIGGER\s+(?!IF\s+NOT\s+EXISTS\b)/i.test(trimmed)) {
    return trimmed.replace(/^CREATE\s+TRIGGER\s+/i, "CREATE TRIGGER IF NOT EXISTS ");
  }
  return trimmed;
}

function applySqlFile(db, sqlPath) {
  const sql = fs.readFileSync(sqlPath, "utf8");
  const statements = splitMigrationStatements(sql);
  for (const stmt of statements) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name|already exists/i.test(msg)) {
        throw new Error(`Failed executing ${path.basename(sqlPath)}: ${msg}\nSQL: ${stmt}`, {
          cause: err,
        });
      }
    }
  }
}

/**
 * Deterministic FK-ordered logical SQL export over a local SQLite database
 * (mirrors scripts/backup-restore/platform-backup.ts format v1).
 */
export function exportSqliteLogicalSql(db) {
  const tables = db
    .prepare(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY name ASC`,
    )
    .all();

  const indexes = db
    .prepare(
      `SELECT name, tbl_name, sql
       FROM sqlite_master
       WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY tbl_name ASC, name ASC`,
    )
    .all();

  const triggers = db
    .prepare(
      `SELECT name, tbl_name, sql
       FROM sqlite_master
       WHERE type = 'trigger' AND sql IS NOT NULL
       ORDER BY tbl_name ASC, name ASC`,
    )
    .all();

  const ddlByName = new Map();
  const deps = new Map();
  for (const row of tables) {
    ddlByName.set(row.name, normalizeCreateDdl(row.sql));
    const fks = db.prepare(`PRAGMA foreign_key_list("${row.name}")`).all();
    const parents = new Set();
    for (const fk of fks) {
      if (fk.table && fk.table !== row.name) parents.add(fk.table);
    }
    deps.set(row.name, parents);
  }

  // Topological sort (parents before children, alphabetical tie-break)
  const names = [...ddlByName.keys()];
  const known = new Set(names);
  const inDeg = new Map(names.map((n) => [n, 0]));
  const children = new Map(names.map((n) => [n, []]));
  for (const tbl of names) {
    for (const p of deps.get(tbl) ?? []) {
      if (!known.has(p)) continue;
      inDeg.set(tbl, (inDeg.get(tbl) ?? 0) + 1);
      children.get(p).push(tbl);
    }
  }
  const ready = names.filter((n) => inDeg.get(n) === 0).sort();
  const ordered = [];
  while (ready.length > 0) {
    const next = ready.shift();
    ordered.push(next);
    for (const child of children.get(next) ?? []) {
      const rem = (inDeg.get(child) ?? 1) - 1;
      inDeg.set(child, rem);
      if (rem === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  for (const n of names.sort()) {
    if (!ordered.includes(n)) ordered.push(n);
  }

  const lines = [
    "-- PunyaSitus isolated backup-restore drill logical SQL export (format v1)",
    "",
  ];
  for (const tbl of ordered) {
    lines.push(`${ddlByName.get(tbl)};`);
  }
  lines.push("");

  const tableRowCounts = {};
  let totalRows = 0;
  for (const tbl of ordered) {
    const cols = db.prepare(`PRAGMA table_info("${tbl}")`).all().sort((a, b) => a.cid - b.cid);
    const colNames = cols.map((c) => c.name);
    const pkCols = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => `"${c.name}"`);
    const orderBy = pkCols.length > 0 ? pkCols.join(", ") : colNames[0] ? `"${colNames[0]}"` : "1";
    const selectCols = colNames.map((c) => `"${c}"`).join(", ");
    const rows = db.prepare(`SELECT ${selectCols} FROM "${tbl}" ORDER BY ${orderBy}`).all();
    tableRowCounts[tbl] = rows.length;
    totalRows += rows.length;
    for (const row of rows) {
      const values = colNames.map((c) => formatSqlLiteral(row[c])).join(", ");
      lines.push(`INSERT INTO "${tbl}" (${selectCols}) VALUES (${values});`);
    }
  }
  lines.push("");

  for (const idx of indexes) {
    lines.push(`${normalizeCreateDdl(idx.sql)};`);
  }
  lines.push("");
  for (const trig of triggers) {
    lines.push(`${normalizeCreateDdl(trig.sql)};`);
  }
  lines.push("");

  const sql = lines.join("\n");
  return {
    sql,
    sha256: sha256Hex(Buffer.from(sql, "utf8")),
    byteLength: Buffer.byteLength(sql, "utf8"),
    tableCount: ordered.length,
    totalRows,
    tableRowCounts,
  };
}

function copyDirRecursive(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function listFilesRelative(dir, prefix = "", out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFilesRelative(full, rel, out);
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Executes an isolated end-to-end backup, SHA-256 verification, restore, and
 * DEC-022 deletion tombstone replay drill using local SQLite databases and
 * isolated synthetic backup/media directories (zero production mutations).
 */
export function runBackupRestoreDrill(options = {}) {
  const rootDir = options.rootDir ?? DEFAULT_ROOT;
  const simulateTamperedChecksum = Boolean(options.simulateTamperedChecksum);
  const simulateTamperedTenantSnapshot = Boolean(options.simulateTamperedTenantSnapshot);
  const simulateTamperedManifest = Boolean(options.simulateTamperedManifest);
  const nowMs = Math.floor(options.nowMs ?? Date.now());
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "punyasitus-backup-drill-"));

  try {
    const platformMigPath = path.join(rootDir, "packages/db/migrations/platform/0001_initial_platform.sql");
    const tenantMigPath = path.join(rootDir, "packages/db/migrations/tenant/0001_initial_tenant.sql");
    if (!fs.existsSync(platformMigPath) || !fs.existsSync(tenantMigPath)) {
      throw new Error("Missing baseline platform/tenant SQL migration files");
    }

    const srcPlatformPath = path.join(workDir, "src-platform.sqlite");
    const srcActiveTenantPath = path.join(workDir, "src-tenant-active.sqlite");
    const srcPurgedTenantPath = path.join(workDir, "src-tenant-purged.sqlite");
    const srcMediaDir = path.join(workDir, "src-media-r2");
    const backupArchiveDir = path.join(workDir, "backup-archive");
    const restoredDir = path.join(workDir, "restored-isolated");
    fs.mkdirSync(srcMediaDir, { recursive: true });
    fs.mkdirSync(backupArchiveDir, { recursive: true });
    fs.mkdirSync(restoredDir, { recursive: true });

    const activeTenant = {
      id: "01JT038ACTIVE0000000000001",
      orgId: "org_t038_active",
      handle: "drill-aktif",
      name: "PT Drill Aktif Nusantara",
      host: "drill-aktif.situsku.click",
      bookmark: "pitr-bm-t038-active-20261124",
      mediaKey: "t/01JT038ACTIVE0000000000001/media/hero-banner.webp",
    };
    const deletedTenant = {
      id: "01JT038PURGED0000000000002",
      orgId: "org_t038_purged",
      handle: "drill-terhapus",
      name: "CV Drill Terhapus Permanen",
      host: "drill-terhapus.situsku.click",
      bookmark: "pitr-bm-t038-purged-20261124",
      mediaKey: "t/01JT038PURGED0000000000002/media/deleted-asset.webp",
    };

    // -------------------------------------------------------------------------
    // STEP 1: Seed synthetic pre-deletion PLATFORM_DB + TenantStores + R2 media
    // -------------------------------------------------------------------------
    const srcPlatform = new DatabaseSync(srcPlatformPath);
    try {
      applySqlFile(srcPlatform, platformMigPath);

      for (const t of [activeTenant, deletedTenant]) {
        srcPlatform
          .prepare("INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run(t.orgId, t.name, t.handle, nowMs, nowMs);
        srcPlatform
          .prepare(
            `INSERT INTO tenants (id, organization_id, handle, name, vertical, status, operator_hold, paid_through, cache_version, schema_version, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'compro', 'active', 0, ?, 1, 24, 1, ?, ?)`,
          )
          .run(t.id, t.orgId, t.handle, t.name, nowMs + 30 * 86_400_000, nowMs, nowMs);
        srcPlatform
          .prepare(
            `INSERT INTO tenant_hosts (host, tenant_id, kind, status, ssl_status, is_primary, verified_at, version, created_at, updated_at)
             VALUES (?, ?, 'subdomain', 'active', 'active', 1, ?, 1, ?, ?)`,
          )
          .run(t.host, t.id, nowMs, nowMs, nowMs);
        srcPlatform
          .prepare(
            `INSERT INTO migration_bookmarks (id, tenant_id, target_version, target_migration, bookmark, status, created_at, completed_at)
             VALUES (?, ?, 24, '0024_lead_preferred_schedule', ?, 'applied', ?, ?)`,
          )
          .run(`bm_${t.handle}`, t.id, t.bookmark, nowMs, nowMs);
      }

      // Write synthetic R2 media objects for both tenants before deletion
      for (const t of [activeTenant, deletedTenant]) {
        const mediaPath = path.join(srcMediaDir, t.mediaKey);
        fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
        fs.writeFileSync(mediaPath, Buffer.from(`synthetic-webp-bytes:${t.id}`, "utf8"));
      }
    } finally {
      srcPlatform.close();
    }

    // Seed Active TenantStore with published page, blog post, offering & media record
    const srcActiveTenant = new DatabaseSync(srcActiveTenantPath);
    try {
      applySqlFile(srcActiveTenant, tenantMigPath);
      srcActiveTenant
        .prepare(
          `INSERT INTO site_settings (id, site_title, tagline, active_theme_id, blog_enabled, catalog_enabled, ai_training_policy, version, updated_at)
           VALUES (1, ?, 'Situs Bisnis Andal', 'compro', 1, 1, 'disallow', 1, ?)`,
        )
        .run(activeTenant.name, nowMs);
      srcActiveTenant
        .prepare(
          `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, published_sections_json, status, published_at, version, created_at, updated_at)
           VALUES (1, 'beranda', 'Beranda PT Drill Aktif', 1, '[]', '[]', 'published', ?, 1, ?, ?)`,
        )
        .run(nowMs, nowMs, nowMs);
      srcActiveTenant
        .prepare(
          `INSERT INTO posts (id, slug, title, excerpt, draft_body_json, published_body_json, status, published_at, version, created_at, updated_at)
           VALUES (1, 'panduan-pemulihan-cadangan', 'Panduan Pemulihan Cadangan', 'Ringkasan cadangan', '{"html":"<p>Isi artikel terverifikasi.</p>"}', '{"html":"<p>Isi artikel terverifikasi.</p>"}', 'published', ?, 1, ?, ?)`,
        )
        .run(nowMs, nowMs, nowMs);
      srcActiveTenant
        .prepare(
          `INSERT INTO offerings (id, offering_type, slug, title, summary, description, price_mode, price, cta_mode, status, published_at, version, created_at, updated_at)
           VALUES (1, 'vehicle', 'toyota-zenix-hybrid', 'Toyota Kijang Innova Zenix Hybrid', 'MPV Hybrid keluarga', '<p>Unit siap kirim.</p>', 'fixed', 485000000, 'whatsapp', 'published', ?, 1, ?, ?)`,
        )
        .run(nowMs, nowMs, nowMs);
      const activeMediaSha = sha256Hex(Buffer.from(`synthetic-webp-bytes:${activeTenant.id}`, "utf8"));
      srcActiveTenant
        .prepare(
          `INSERT INTO media_items (id, kind, r2_key, mime_type, bytes, sha256, alt_text, status, version, created_at, updated_at)
           VALUES (1, 'image', ?, 'image/webp', 54, ?, 'Banner utama', 'ready', 1, ?, ?)`,
        )
        .run(activeTenant.mediaKey, activeMediaSha, nowMs, nowMs);
    } finally {
      srcActiveTenant.close();
    }

    // Seed Purged TenantStore (active prior to backup)
    const srcPurgedTenant = new DatabaseSync(srcPurgedTenantPath);
    try {
      applySqlFile(srcPurgedTenant, tenantMigPath);
      srcPurgedTenant
        .prepare(
          `INSERT INTO pages (id, slug, title, is_homepage, draft_sections_json, published_sections_json, status, published_at, version, created_at, updated_at)
           VALUES (1, 'beranda', 'Halaman Terhapus', 1, '[]', '[]', 'published', ?, 1, ?, ?)`,
        )
        .run(nowMs, nowMs, nowMs);
    } finally {
      srcPurgedTenant.close();
    }

    // -------------------------------------------------------------------------
    // STEP 2: Take pre-deletion SHA-256 checksummed backup archive
    // -------------------------------------------------------------------------
    const srcPlatformRead = new DatabaseSync(srcPlatformPath, { readOnly: true });
    let platformExport;
    try {
      platformExport = exportSqliteLogicalSql(srcPlatformRead);
    } finally {
      srcPlatformRead.close();
    }
    const srcActiveRead = new DatabaseSync(srcActiveTenantPath, { readOnly: true });
    let activeTenantExport;
    try {
      activeTenantExport = exportSqliteLogicalSql(srcActiveRead);
    } finally {
      srcActiveRead.close();
    }
    const srcPurgedRead = new DatabaseSync(srcPurgedTenantPath, { readOnly: true });
    let purgedTenantExport;
    try {
      purgedTenantExport = exportSqliteLogicalSql(srcPurgedRead);
    } finally {
      srcPurgedRead.close();
    }

    const platformSnapFile = path.join(backupArchiveDir, "platform-snapshot.sql");
    const activeTenantSnapFile = path.join(backupArchiveDir, `tenant-${activeTenant.id}.sql`);
    const purgedTenantSnapFile = path.join(backupArchiveDir, `tenant-${deletedTenant.id}.sql`);
    const backupMediaDir = path.join(backupArchiveDir, "media-r2");

    fs.writeFileSync(platformSnapFile, platformExport.sql, "utf8");
    fs.writeFileSync(activeTenantSnapFile, activeTenantExport.sql, "utf8");
    fs.writeFileSync(purgedTenantSnapFile, purgedTenantExport.sql, "utf8");
    copyDirRecursive(srcMediaDir, backupMediaDir);

    const backupManifest = {
      formatVersion: 1,
      createdAt: new Date(nowMs).toISOString(),
      platformSnapshot: {
        file: "platform-snapshot.sql",
        sha256: platformExport.sha256,
        byteLength: platformExport.byteLength,
        tableCount: platformExport.tableCount,
        totalRows: platformExport.totalRows,
        tableRowCounts: platformExport.tableRowCounts,
      },
      tenantSnapshots: {
        [activeTenant.id]: {
          file: `tenant-${activeTenant.id}.sql`,
          sha256: activeTenantExport.sha256,
          byteLength: activeTenantExport.byteLength,
          tableRowCounts: activeTenantExport.tableRowCounts,
          pitrBookmark: activeTenant.bookmark,
        },
        [deletedTenant.id]: {
          file: `tenant-${deletedTenant.id}.sql`,
          sha256: purgedTenantExport.sha256,
          byteLength: purgedTenantExport.byteLength,
          tableRowCounts: purgedTenantExport.tableRowCounts,
          pitrBookmark: deletedTenant.bookmark,
        },
      },
      mediaFiles: listFilesRelative(backupMediaDir).map((relKey) => ({
        key: relKey,
        sha256: sha256Hex(fs.readFileSync(path.join(backupMediaDir, relKey))),
      })),
    };
    const manifestJson = JSON.stringify(backupManifest, null, 2);
    const manifestPath = path.join(backupArchiveDir, "manifest.json");
    const manifestShaPath = path.join(backupArchiveDir, "manifest.json.sha256");
    fs.writeFileSync(manifestPath, manifestJson, "utf8");
    const archiveManifestSha256 = sha256Hex(Buffer.from(manifestJson, "utf8"));
    fs.writeFileSync(manifestShaPath, archiveManifestSha256, "utf8");

    if (simulateTamperedManifest) {
      fs.appendFileSync(manifestPath, "\n", "utf8");
    }
    if (simulateTamperedChecksum) {
      fs.appendFileSync(platformSnapFile, "\n-- tampered byte\n", "utf8");
    }
    if (simulateTamperedTenantSnapshot) {
      fs.appendFileSync(activeTenantSnapFile, "\n-- tampered tenant byte\n", "utf8");
    }

    // -------------------------------------------------------------------------
    // STEP 3: Record post-backup DEC-022 deletion tombstone for deletedTenant
    // -------------------------------------------------------------------------
    const deletedAtMs = nowMs + 60_000;
    const quarantineUntilMs = deletedAtMs + 30 * 24 * 60 * 60 * 1000;
    const authoritativeTombstones = [
      {
        id: "tomb_t038_drill_001",
        tenantId: deletedTenant.id,
        handle: deletedTenant.handle,
        quarantineUntilMs,
        reason: "tenant_self_service_offboarding_dec_022",
        deletedBy: "usr_owner_deleted",
        deletedAtMs,
      },
    ];

    // -------------------------------------------------------------------------
    // STEP 4: Execute timed isolated restore + SHA-256 verification + DEC-022 replay
    // -------------------------------------------------------------------------
    const restoreStartedNs = process.hrtime.bigint();

    const expectedManifestSha = fs.readFileSync(manifestShaPath, "utf8").trim();
    const loadedManifestRaw = fs.readFileSync(manifestPath, "utf8");
    const actualManifestSha = sha256Hex(Buffer.from(loadedManifestRaw, "utf8"));
    if (actualManifestSha !== expectedManifestSha) {
      throw new Error(
        `BACKUP_MANIFEST_CHECKSUM_MISMATCH: expected ${expectedManifestSha}, got ${actualManifestSha}`,
      );
    }
    const loadedManifest = JSON.parse(loadedManifestRaw);
    const restoredPlatformSql = fs.readFileSync(
      path.join(backupArchiveDir, loadedManifest.platformSnapshot.file),
      "utf8",
    );
    const verifiedPlatformSha256 = sha256Hex(Buffer.from(restoredPlatformSql, "utf8"));
    if (verifiedPlatformSha256 !== loadedManifest.platformSnapshot.sha256) {
      throw new Error(
        `BACKUP_CHECKSUM_MISMATCH: expected ${loadedManifest.platformSnapshot.sha256}, got ${verifiedPlatformSha256}`,
      );
    }

    const restoredPlatformPath = path.join(restoredDir, "platform-restored.sqlite");
    const restoredActiveTenantPath = path.join(restoredDir, `tenant-${activeTenant.id}.sqlite`);
    const restoredPurgedTenantPath = path.join(restoredDir, `tenant-${deletedTenant.id}.sqlite`);
    const restoredMediaDir = path.join(restoredDir, "media-r2");

    // 4a. Restore pre-deletion PLATFORM_DB into clean isolated target DB
    const targetPlatform = new DatabaseSync(restoredPlatformPath);
    let resurrectedBeforeReplay = false;
    let platformCountsMatched = true;
    let activeTenantStatusAfterReplay = null;
    let deletedTenantStatusAfterReplay = null;
    let deletedActiveHostsAfterReplay = -1;
    let activeBookmarkVerified = false;
    let tombstonesReplayedCount = 0;

    try {
      for (const stmt of splitMigrationStatements(restoredPlatformSql)) {
        targetPlatform.exec(stmt);
      }

      // Verify restored pre-replay row counts match manifest 1:1
      for (const [tbl, expectedCnt] of Object.entries(loadedManifest.platformSnapshot.tableRowCounts)) {
        const row = targetPlatform.prepare(`SELECT COUNT(*) AS cnt FROM "${tbl}"`).get();
        if (Number(row?.cnt ?? 0) !== expectedCnt) {
          platformCountsMatched = false;
        }
      }

      // Confirm that WITHOUT tombstone replay, deletedTenant would have been resurrected as 'active'!
      const preReplayDeleted = targetPlatform
        .prepare("SELECT status FROM tenants WHERE id = ?")
        .get(deletedTenant.id);
      resurrectedBeforeReplay = preReplayDeleted?.status === "active";

      // 4b. Restore TenantStore SQLite DBs & R2 media archive into clean isolated targets
      for (const [tid, snapMeta] of Object.entries(loadedManifest.tenantSnapshots)) {
        const snapSql = fs.readFileSync(path.join(backupArchiveDir, snapMeta.file), "utf8");
        const actualSnapSha = sha256Hex(Buffer.from(snapSql, "utf8"));
        if (actualSnapSha !== snapMeta.sha256) {
          throw new Error(`TENANT_SNAPSHOT_CHECKSUM_MISMATCH for ${tid}`);
        }
        const outDbPath = path.join(restoredDir, `tenant-${tid}.sqlite`);
        const tdb = new DatabaseSync(outDbPath);
        try {
          for (const stmt of splitMigrationStatements(snapSql)) {
            tdb.exec(stmt);
          }
        } finally {
          tdb.close();
        }
      }
      copyDirRecursive(backupMediaDir, restoredMediaDir);

      // 4c. Mandatory DEC-022 Tombstone Replay (sync authoritative tombstones -> re-purge!)
      for (const tomb of authoritativeTombstones) {
        targetPlatform
          .prepare(
            `INSERT INTO deletion_tombstones (
              id, tenant_id, handle, quarantine_until, reason, deleted_by, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id) DO UPDATE SET
              quarantine_until = MAX(deletion_tombstones.quarantine_until, excluded.quarantine_until),
              reason = excluded.reason`,
          )
          .run(
            tomb.id,
            tomb.tenantId,
            tomb.handle,
            tomb.quarantineUntilMs,
            tomb.reason,
            tomb.deletedBy,
            tomb.deletedAtMs,
          );

        targetPlatform
          .prepare(
            `UPDATE tenants
             SET status = 'purged', operator_hold = 1, cache_version = cache_version + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(deletedAtMs, tomb.tenantId);

        targetPlatform
          .prepare(
            `UPDATE tenant_hosts
             SET status = 'deleting', is_primary = 0, quarantined_until = ?, updated_at = ?
             WHERE tenant_id = ?`,
          )
          .run(tomb.quarantineUntilMs, deletedAtMs, tomb.tenantId);

        // Purge tombstoned tenant R2 media prefix and tombstoned TenantStore SQLite file
        fs.rmSync(path.join(restoredMediaDir, "t", tomb.tenantId), {
          recursive: true,
          force: true,
        });
        fs.rmSync(path.join(restoredDir, `tenant-${tomb.tenantId}.sqlite`), { force: true });
        tombstonesReplayedCount += 1;
      }

      const activeRow = targetPlatform
        .prepare("SELECT status FROM tenants WHERE id = ?")
        .get(activeTenant.id);
      const deletedRow = targetPlatform
        .prepare("SELECT status FROM tenants WHERE id = ?")
        .get(deletedTenant.id);
      const deletedHostsRow = targetPlatform
        .prepare(
          `SELECT COUNT(*) AS cnt FROM tenant_hosts
           WHERE tenant_id = ? AND (status != 'deleting' OR is_primary != 0)`,
        )
        .get(deletedTenant.id);
      const bookmarkRow = targetPlatform
        .prepare(
          `SELECT bookmark, status FROM migration_bookmarks
           WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(activeTenant.id);

      activeTenantStatusAfterReplay = activeRow?.status ?? null;
      deletedTenantStatusAfterReplay = deletedRow?.status ?? null;
      deletedActiveHostsAfterReplay = Number(deletedHostsRow?.cnt ?? -1);
      activeBookmarkVerified =
        bookmarkRow?.bookmark === activeTenant.bookmark && bookmarkRow?.status === "applied";
    } finally {
      targetPlatform.close();
    }

    // 4d. Verify restored Active TenantStore checksum & live records match 100%
    const restoredActiveDb = new DatabaseSync(restoredActiveTenantPath, { readOnly: true });
    let restoredActiveExport;
    let activeRecords = {};
    try {
      restoredActiveExport = exportSqliteLogicalSql(restoredActiveDb);
      activeRecords = {
        pages: Number(restoredActiveDb.prepare("SELECT COUNT(*) AS cnt FROM pages").get()?.cnt ?? 0),
        posts: Number(restoredActiveDb.prepare("SELECT COUNT(*) AS cnt FROM posts").get()?.cnt ?? 0),
        offerings: Number(
          restoredActiveDb.prepare("SELECT COUNT(*) AS cnt FROM offerings").get()?.cnt ?? 0,
        ),
        mediaItems: Number(
          restoredActiveDb.prepare("SELECT COUNT(*) AS cnt FROM media_items").get()?.cnt ?? 0,
        ),
      };
    } finally {
      restoredActiveDb.close();
    }

    const activeTenantChecksumMatched = restoredActiveExport.sha256 === activeTenantExport.sha256;
    const activeMediaExists = fs.existsSync(path.join(restoredMediaDir, activeTenant.mediaKey));
    const activeMediaShaMatched =
      activeMediaExists &&
      sha256Hex(fs.readFileSync(path.join(restoredMediaDir, activeTenant.mediaKey))) ===
        loadedManifest.mediaFiles.find((m) => m.key === activeTenant.mediaKey)?.sha256;
    const deletedMediaFilesRemaining = listFilesRelative(
      path.join(restoredMediaDir, "t", deletedTenant.id),
    );
    const deletedTenantStoreRemoved = !fs.existsSync(restoredPurgedTenantPath);

    const rtoMs = Number((process.hrtime.bigint() - restoreStartedNs) / 1_000_000n);

    const ok =
      platformCountsMatched &&
      resurrectedBeforeReplay &&
      activeTenantStatusAfterReplay === "active" &&
      deletedTenantStatusAfterReplay === "purged" &&
      deletedActiveHostsAfterReplay === 0 &&
      activeBookmarkVerified &&
      activeTenantChecksumMatched &&
      activeMediaExists &&
      activeMediaShaMatched &&
      deletedMediaFilesRemaining.length === 0 &&
      deletedTenantStoreRemoved &&
      activeRecords.pages === 1 &&
      activeRecords.posts === 1 &&
      activeRecords.offerings === 1 &&
      activeRecords.mediaItems === 1 &&
      rtoMs <= RTO_BUDGET_MS;

    return {
      ok,
      gate: "ISOLATED_BACKUP_RESTORE_AND_DEC022_TOMBSTONE_DRILL",
      task: "TASK-038",
      requirement: "REQ-042",
      decisionReference: "DEC-022",
      executedAt: new Date().toISOString(),
      rtoMs,
      rtoBudgetMs: RTO_BUDGET_MS,
      withinRtoBudget: rtoMs <= RTO_BUDGET_MS,
      checksums: {
        archiveManifestSha256,
        platformSnapshotSha256: verifiedPlatformSha256,
        activeTenantStoreSha256: restoredActiveExport.sha256,
        activeTenantChecksumMatched,
        activeMediaShaMatched,
      },
      platformRestore: {
        tablesRestored: loadedManifest.platformSnapshot.tableCount,
        rowsRestored: loadedManifest.platformSnapshot.totalRows,
        rowCountsMatched: platformCountsMatched,
        activeBookmarkVerified,
      },
      activeTenantVerification: {
        tenantId: activeTenant.id,
        status: activeTenantStatusAfterReplay,
        records: activeRecords,
        mediaVerified: activeMediaExists && activeMediaShaMatched,
      },
      tombstoneReplayVerification: {
        tombstonedTenantId: deletedTenant.id,
        wouldHaveResurrectedWithoutReplay: resurrectedBeforeReplay,
        tombstonesReplayedCount,
        statusAfterReplay: deletedTenantStatusAfterReplay,
        activeHostsAfterReplay: deletedActiveHostsAfterReplay,
        r2ObjectsRemaining: deletedMediaFilesRemaining.length,
        tenantStoreRemoved: deletedTenantStoreRemoved,
        resurrectionPrevented:
          resurrectedBeforeReplay &&
          deletedTenantStatusAfterReplay === "purged" &&
          deletedActiveHostsAfterReplay === 0 &&
          deletedMediaFilesRemaining.length === 0 &&
          deletedTenantStoreRemoved,
      },
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function verifyRollbackPlan(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const releaseMdPath = path.join(rootDir, "RELEASE.md");
  const backupRunbookPath = path.join(rootDir, "docs/operations/backup-restore.md");
  const restoreDrillSrcPath = path.join(rootDir, "scripts/backup-restore/restore-drill.ts");

  if (!fs.existsSync(releaseMdPath)) {
    errors.push("Missing RELEASE.md");
  } else {
    const text = fs.readFileSync(releaseMdPath, "utf8");
    if (!/First-Release Rollback Plan/i.test(text)) {
      errors.push("RELEASE.md missing First-Release Rollback Plan section");
    }
    if (!/DEC-022/i.test(text)) {
      errors.push("RELEASE.md missing DEC-022 tombstone replay step");
    }
    if (!/^Backup-Proof:\s*(?:backup|snapshot|artifact|s3|r2|gs):\/\//im.test(text)) {
      errors.push("RELEASE.md missing structured Backup-Proof URI");
    }
  }
  if (!fs.existsSync(backupRunbookPath)) {
    errors.push("Missing docs/operations/backup-restore.md");
  }
  if (!fs.existsSync(restoreDrillSrcPath)) {
    errors.push("Missing scripts/backup-restore/restore-drill.ts");
  }

  const drill = runBackupRestoreDrill({ rootDir });
  if (!drill.ok) {
    errors.push("Isolated backup/restore & DEC-022 tombstone replay drill failed");
  }

  return {
    ok: errors.length === 0 && drill.ok,
    mode: "verify-rollback-plan",
    nonDestructive: true,
    verifiedAt: new Date().toISOString(),
    errors,
    drill,
  };
}

function parseCliArgs(argv) {
  const args = {
    verifyRollbackPlan: false,
    jsonOnly: false,
    reportOut: null,
    rootDir: DEFAULT_ROOT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--verify-rollback-plan") {
      args.verifyRollbackPlan = true;
    } else if (token === "--json") {
      args.jsonOnly = true;
    } else if (token === "--report-out" && argv[i + 1]) {
      args.reportOut = path.resolve(argv[++i]);
    } else if (token === "--root" && argv[i + 1]) {
      args.rootDir = path.resolve(argv[++i]);
    } else if (token === "--help" || token === "-h") {
      console.log(
        "Usage: node scripts/verify/backup-restore-drill.mjs [--verify-rollback-plan] [--json] [--report-out <path>] [--root <dir>]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const result = args.verifyRollbackPlan
    ? verifyRollbackPlan(args.rootDir)
    : runBackupRestoreDrill({ rootDir: args.rootDir });

  if (args.reportOut) {
    fs.mkdirSync(path.dirname(args.reportOut), { recursive: true });
    fs.writeFileSync(args.reportOut, JSON.stringify(result, null, 2) + "\n", "utf8");
  }

  if (args.jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const drill = args.verifyRollbackPlan ? result.drill : result;
    console.log(
      `${result.ok ? "PASS" : "FAIL"}: Isolated Backup/Restore & DEC-022 Tombstone Drill (${args.verifyRollbackPlan ? "verify-rollback-plan" : "full-drill"}) — rtoMs=${drill.rtoMs}ms, platformSha256=${drill.checksums.platformSnapshotSha256.slice(0, 16)}..., activeChecksumMatched=${String(drill.checksums.activeTenantChecksumMatched)}, resurrectionPrevented=${String(drill.tombstoneReplayVerification.resurrectionPrevented)}`,
    );
    console.log(
      JSON.stringify({
        ok: result.ok,
        rtoMs: drill.rtoMs,
        checksums: drill.checksums,
        resurrectionPrevented: drill.tombstoneReplayVerification.resurrectionPrevented,
        reportOut: args.reportOut,
      }),
    );
  }

  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error("BACKUP RESTORE DRILL FAILED:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
