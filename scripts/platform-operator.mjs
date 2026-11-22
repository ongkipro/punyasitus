#!/usr/bin/env node
/**
 * Trusted-environment Platform Operator Bootstrap & Recovery CLI (`REQ-051`, `PLAN §13`).
 *
 * Security invariants:
 * - Never creates public signups or default passwords.
 * - Requires an existing verified account (`users.email_verified = 1`).
 * - Requires an explicit 10-500 character audit reason (scrubbed for secrets/PII).
 * - Writes `platform_operators` + `platform_audit` inside a single atomic SQLite transaction.
 * - Defaults strictly to local D1 (`--local`); refuses production execution unless explicit
 *   confirmation flags are provided (and even then outputs a reviewable plan instead of
 *   mutating production directly).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const VALID_MODES = new Set(["bootstrap", "recover", "list"]);
export const VALID_TARGETS = new Set(["local", "staging", "production"]);
export const PRODUCTION_CONFIRM_TOKEN = "CONFIRM_PRODUCTION_OPERATOR_BOOTSTRAP";

const MIN_REASON_LENGTH = 10;
const MAX_REASON_LENGTH = 500;
const EMAIL_RE = /^[^\s@<>,;"'\\]+@[^\s@<>,;"'\\]+\.[^\s@<>,;"'\\]{2,}$/;
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CONTROL_CHARS_RE = /[\r\n\t\p{Cc}]+/gu;
const SECRET_PATTERN_RE =
  /(?:-----BEGIN [A-Z0-9 ]+-----|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}|\b(?:sk_live|sk_test|whsec|ghp|AIza|AKIA|cf_|re_)[A-Za-z0-9_-]{8,}|\b(?:password|passwd|secret|token|cookie|authorization|api[_-]?key|totp[_-]?secret|backup[_-]?codes?)\s*[:=]\s*[^\s,;'"}\]]+)/gi;

export class CliValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliValidationError";
  }
}

export function generateUlid(nowMs = Date.now()) {
  let timeRemaining = Math.max(0, Math.trunc(nowMs));
  const timeChars = new Array(10);
  for (let i = 9; i >= 0; i -= 1) {
    timeChars[i] = CROCKFORD_BASE32[timeRemaining % 32];
    timeRemaining = Math.floor(timeRemaining / 32);
  }
  const randBytes = crypto.randomBytes(16);
  const randChars = new Array(16);
  for (let i = 0; i < 16; i += 1) {
    randChars[i] = CROCKFORD_BASE32[randBytes[i] & 31];
  }
  return `${timeChars.join("")}${randChars.join("")}`;
}

export function redactCliReason(rawReason) {
  return String(rawReason ?? "")
    .replace(CONTROL_CHARS_RE, " ")
    .replace(SECRET_PATTERN_RE, "[REDACTED]")
    .trim();
}

export function parseCliArgs(argv) {
  const parsed = {
    mode: null,
    email: null,
    reason: null,
    dbPersist: null,
    dbFile: null,
    target: "local",
    local: false,
    allowAdditional: false,
    allowProduction: false,
    confirmProduction: null,
    reset2fa: false,
    requestId: null,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--local") {
      parsed.local = true;
      parsed.target = "local";
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--allow-additional") {
      parsed.allowAdditional = true;
      continue;
    }
    if (arg === "--allow-production") {
      parsed.allowProduction = true;
      continue;
    }
    if (arg === "--reset-2fa") {
      parsed.reset2fa = true;
      continue;
    }

    // Explicitly forbid insecure default-password or user-creation flags
    if (
      arg === "--password" ||
      arg.startsWith("--password=") ||
      arg === "--create-user" ||
      arg === "--default-password"
    ) {
      throw new CliValidationError(
        `Flag "${arg}" is forbidden: operator bootstrap never creates users or default passwords.`,
      );
    }

    const eqIdx = arg.indexOf("=");
    let key = arg;
    let value = null;
    if (eqIdx > 0) {
      key = arg.slice(0, eqIdx);
      value = arg.slice(eqIdx + 1);
    } else if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new CliValidationError(`Flag "${arg}" requires a value.`);
      }
      value = next;
      i += 1;
    } else {
      throw new CliValidationError(`Unexpected positional argument "${arg}".`);
    }

    switch (key) {
      case "--mode":
        parsed.mode = value;
        break;
      case "--email":
        parsed.email = value;
        break;
      case "--reason":
        parsed.reason = value;
        break;
      case "--db-persist":
        parsed.dbPersist = value;
        break;
      case "--db-file":
        parsed.dbFile = value;
        break;
      case "--target":
        parsed.target = value;
        break;
      case "--confirm-production":
        parsed.confirmProduction = value;
        break;
      case "--request-id":
        parsed.requestId = value;
        break;
      default:
        throw new CliValidationError(`Unknown CLI flag "${key}".`);
    }
  }

  return parsed;
}

export function validateCliOptions(raw) {
  if (raw.help) {
    return { ...raw };
  }

  if (!raw.mode || !VALID_MODES.has(raw.mode)) {
    throw new CliValidationError(
      `Invalid or missing --mode. Expected one of: ${Array.from(VALID_MODES).join(", ")}.`,
    );
  }

  if (!raw.target || !VALID_TARGETS.has(raw.target)) {
    throw new CliValidationError(
      `Invalid --target "${String(raw.target)}". Expected one of: local, staging, production.`,
    );
  }

  if (raw.local && raw.target !== "local") {
    throw new CliValidationError("--local cannot be combined with a non-local --target.");
  }

  if (raw.target === "production") {
    if (!raw.allowProduction || raw.confirmProduction !== PRODUCTION_CONFIRM_TOKEN) {
      throw new CliValidationError(
        `Refusing production target without explicit --allow-production and --confirm-production=${PRODUCTION_CONFIRM_TOKEN}.`,
      );
    }
  }

  if (raw.reset2fa && raw.mode !== "recover") {
    throw new CliValidationError("--reset-2fa is only permitted with --mode recover.");
  }

  let normalizedEmail = null;
  let cleanReason = null;

  if (raw.mode === "bootstrap" || raw.mode === "recover") {
    if (!raw.email || typeof raw.email !== "string") {
      throw new CliValidationError(`--email is required for --mode ${raw.mode}.`);
    }
    normalizedEmail = raw.email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalizedEmail) || normalizedEmail.length > 254) {
      throw new CliValidationError("Provided --email is not a valid email address.");
    }

    if (!raw.reason || typeof raw.reason !== "string") {
      throw new CliValidationError(
        `--reason (${MIN_REASON_LENGTH}-${MAX_REASON_LENGTH} chars) is required for --mode ${raw.mode}.`,
      );
    }

    const trimmed = raw.reason.replace(CONTROL_CHARS_RE, " ").trim();
    if (trimmed.length < MIN_REASON_LENGTH || trimmed.length > MAX_REASON_LENGTH) {
      throw new CliValidationError(
        `--reason must be between ${MIN_REASON_LENGTH} and ${MAX_REASON_LENGTH} characters.`,
      );
    }
    cleanReason = redactCliReason(trimmed).slice(0, MAX_REASON_LENGTH);
    if (cleanReason.length < MIN_REASON_LENGTH) {
      throw new CliValidationError(
        `--reason must contain at least ${MIN_REASON_LENGTH} non-sensitive characters.`,
      );
    }
  }

  if (raw.target === "local" && !raw.dbPersist && !raw.dbFile) {
    throw new CliValidationError(
      "Local execution requires --db-persist <dir> or --db-file <path>.",
    );
  }

  if (raw.dbPersist && raw.dbFile) {
    throw new CliValidationError("Specify either --db-persist or --db-file, not both.");
  }

  return {
    ...raw,
    email: normalizedEmail,
    reason: cleanReason,
    allowAdditional: raw.mode === "recover" ? true : raw.allowAdditional,
    requestId: raw.requestId?.trim() || `cli_${generateUlid()}`,
  };
}

function findSqliteFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findSqliteFiles(full, out);
    } else if (entry.name.endsWith(".sqlite") || entry.name.endsWith(".db")) {
      out.push(full);
    }
  }
  return out;
}

export function resolveLocalSqlitePath(options) {
  if (options.dbFile) {
    const resolved = path.resolve(options.dbFile);
    if (!fs.existsSync(resolved)) {
      throw new CliValidationError(`SQLite database file not found: ${resolved}`);
    }
    return resolved;
  }

  const persistDir = path.resolve(options.dbPersist);
  if (!fs.existsSync(persistDir)) {
    throw new CliValidationError(`D1 persist directory not found: ${persistDir}`);
  }

  const candidates = findSqliteFiles(persistDir).sort((a, b) => {
    const statA = fs.statSync(a).mtimeMs;
    const statB = fs.statSync(b).mtimeMs;
    return statB - statA;
  });

  for (const file of candidates) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'platform_operators' LIMIT 1",
        )
        .get();
      if (row) {
        return file;
      }
    } finally {
      db.close();
    }
  }

  throw new CliValidationError(
    `No migrated PLATFORM_DB SQLite file with table "platform_operators" found under ${persistDir}.`,
  );
}

export function executeLocalOperatorAction(options, nowMs = Date.now()) {
  const sqlitePath = resolveLocalSqlitePath(options);
  const db = new DatabaseSync(sqlitePath, { readOnly: options.mode === "list" || options.dryRun });

  try {
    if (options.mode === "list") {
      const rows = db
        .prepare(
          `
          SELECT
            po.user_id,
            u.email,
            u.email_verified,
            u.two_factor_enabled,
            po.granted_by,
            po.granted_at,
            po.revoked_at,
            po.revoked_by
          FROM platform_operators po
          INNER JOIN users u ON u.id = po.user_id
          ORDER BY (po.revoked_at IS NULL) DESC, po.granted_at DESC
          `,
        )
        .all();
      return {
        ok: true,
        mode: "list",
        sqlitePath,
        operators: rows.map((r) => ({
          userId: r.user_id,
          email: r.email,
          emailVerified: r.email_verified === 1,
          twoFactorEnabled: r.two_factor_enabled === 1,
          grantedBy: r.granted_by,
          grantedAt: r.granted_at,
          revokedAt: r.revoked_at,
          revokedBy: r.revoked_by,
          isActive: r.revoked_at === null,
        })),
      };
    }

    const user = db
      .prepare(
        "SELECT id, email, name, email_verified, two_factor_enabled FROM users WHERE lower(email) = ? LIMIT 1",
      )
      .get(options.email);

    if (!user) {
      throw new CliValidationError(
        `No existing account matches --email (operator bootstrap never creates accounts or passwords).`,
      );
    }

    if (user.email_verified !== 1) {
      throw new CliValidationError(
        `Target user "${user.id}" is not email-verified (users.email_verified must be 1).`,
      );
    }

    const activeCountRow = db
      .prepare("SELECT COUNT(*) AS count FROM platform_operators WHERE revoked_at IS NULL")
      .get();
    const activeCount = Number(activeCountRow?.count ?? 0);

    if (options.mode === "bootstrap" && !options.allowAdditional && activeCount > 0) {
      throw new CliValidationError(
        "An active platform operator already exists; use --mode recover for audited recovery.",
      );
    }

    const auditId = generateUlid(nowMs);
    const action =
      options.mode === "recover" ? "platform_operator.recover" : "platform_operator.bootstrap";
    const metadataJson = JSON.stringify({
      mode: options.mode,
      target: options.target,
      reset2fa: Boolean(options.reset2fa),
    });

    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        mode: options.mode,
        sqlitePath,
        userId: user.id,
        action,
        auditId,
        requestId: options.requestId,
        reason: options.reason,
        reset2fa: Boolean(options.reset2fa),
      };
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `
        INSERT INTO platform_operators (
          user_id, granted_by, reason, granted_at, revoked_at, revoked_by, revoke_reason
        ) VALUES (?, NULL, ?, ?, NULL, NULL, NULL)
        ON CONFLICT(user_id) DO UPDATE SET
          granted_by = NULL,
          reason = excluded.reason,
          granted_at = excluded.granted_at,
          revoked_at = NULL,
          revoked_by = NULL,
          revoke_reason = NULL
        `,
      ).run(user.id, options.reason, nowMs);

      if (options.mode === "recover" && options.reset2fa) {
        db.prepare("DELETE FROM two_factors WHERE user_id = ?").run(user.id);
        db.prepare("UPDATE users SET two_factor_enabled = 0, updated_at = ? WHERE id = ?").run(
          nowMs,
          user.id,
        );
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
      }

      db.prepare(
        `
        INSERT INTO platform_audit (
          id, actor_user_id, actor_role, action, target_type, target_id,
          tenant_id, reason, outcome, request_id, metadata_json, created_at
        ) VALUES (?, NULL, ?, ?, 'platform_operator', ?, NULL, ?, 'success', ?, ?, ?)
        `,
      ).run(
        auditId,
        options.mode === "recover" ? "system_recovery" : "system_bootstrap",
        action,
        user.id,
        options.reason,
        options.requestId,
        metadataJson,
        nowMs,
      );

      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    return {
      ok: true,
      dryRun: false,
      mode: options.mode,
      sqlitePath,
      userId: user.id,
      action,
      auditId,
      requestId: options.requestId,
      reset2fa: Boolean(options.reset2fa),
    };
  } finally {
    db.close();
  }
}

function printUsage() {
  console.log(`Usage:
  node scripts/platform-operator.mjs --mode bootstrap --email <verified-email> --reason "<10-500 char reason>" --db-persist <dir> [--local] [--dry-run]
  node scripts/platform-operator.mjs --mode recover   --email <verified-email> --reason "<10-500 char reason>" --db-persist <dir> [--reset-2fa] [--dry-run]
  node scripts/platform-operator.mjs --mode list      --db-persist <dir> [--local]

Notes:
  - Requires an existing email-verified user in PLATFORM_DB.users (never creates accounts or default passwords).
  - Writes platform_operators and platform_audit atomically in a single SQLite transaction.
  - Non-local targets (--target staging|production) never execute unreviewed remote writes directly.`);
}

export function runCli(argv = process.argv.slice(2)) {
  const raw = parseCliArgs(argv);
  const options = validateCliOptions(raw);

  if (options.help) {
    printUsage();
    return { ok: true, help: true };
  }

  if (options.target !== "local") {
    const plan = {
      ok: true,
      dryRun: true,
      target: options.target,
      mode: options.mode,
      requestId: options.requestId,
      reason: options.reason,
      note:
        "Remote staging/production execution requires an audited Wrangler D1 transaction run from a trusted operator terminal per docs/operations/platform-access.md.",
    };
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }

  const result = executeLocalOperatorAction(options);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`platform-operator error: ${message}`);
    process.exit(err instanceof CliValidationError ? 2 : 1);
  }
}
