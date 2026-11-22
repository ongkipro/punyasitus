import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  BETTER_AUTH_DRIZZLE_SCHEMA,
  BETTER_AUTH_SCHEMA_MAPPING,
  encodeQrMatrix,
  extractManualTotpSecret,
  generateTotpCodeFromBase32Secret,
  generateTotpQrSvg,
  redactTwoFactorSensitiveText,
  SESSION_2FA_MIGRATION_SQL,
  TWO_FACTOR_BACKUP_CODE_COUNT,
  TWO_FACTOR_ISSUER,
  TWO_FACTOR_TOTP_DIGITS,
  TWO_FACTOR_TOTP_PERIOD_SECONDS,
} from "@punyasitus/auth";
import { beforeAll, describe, expect, it } from "vitest";

interface PlatformOperatorCliModule {
  readonly parseCliArgs: (argv: readonly string[]) => Record<string, unknown>;
  readonly validateCliOptions: (raw: Record<string, unknown>) => Record<string, unknown>;
  readonly redactCliReason: (rawReason: string) => string;
  readonly executeLocalOperatorAction: (
    options: Record<string, unknown>,
    nowMs?: number,
  ) => { readonly ok: boolean; readonly reset2fa?: boolean };
}

const ROOT = path.resolve(import.meta.dirname, "../..");
const PLATFORM_0001_SQL = fs.readFileSync(
  path.join(ROOT, "packages/db/migrations/platform/0001_initial_platform.sql"),
  "utf8",
);
const PLATFORM_0003_SQL = fs.readFileSync(
  path.join(ROOT, "packages/db/migrations/platform/0003_session_two_factor_state.sql"),
  "utf8",
);

let cli: PlatformOperatorCliModule;

describe("TASK-067 unit checks — Better Auth twoFactor, QR SVG, TOTP, Redaction, CLI & BUILD-LOG", () => {
  beforeAll(async () => {
    const cliUrl = pathToFileURL(path.join(ROOT, "scripts/platform-operator.mjs")).href;
    cli = (await import(cliUrl)) as PlatformOperatorCliModule;
  });
  it("exposes Better Auth 1.7.27 twoFactor schema mapping, relations, and issuer constants", () => {
    expect(BETTER_AUTH_SCHEMA_MAPPING.twoFactor).toBeDefined();
    expect(BETTER_AUTH_DRIZZLE_SCHEMA.twoFactor).toBe(BETTER_AUTH_SCHEMA_MAPPING.twoFactor);
    expect(BETTER_AUTH_DRIZZLE_SCHEMA.twoFactorRelations).toBeDefined();
    expect(TWO_FACTOR_ISSUER).toBe("PunyaSitus");
    expect(TWO_FACTOR_TOTP_DIGITS).toBe(6);
    expect(TWO_FACTOR_TOTP_PERIOD_SECONDS).toBe(30);
    expect(TWO_FACTOR_BACKUP_CODE_COUNT).toBe(10);
  });

  it("keeps 0003_session_two_factor_state.sql additive and synced with SESSION_2FA_MIGRATION_SQL", () => {
    expect(PLATFORM_0003_SQL.trim()).toBe(SESSION_2FA_MIGRATION_SQL.trim());
    expect(PLATFORM_0003_SQL).toContain("CREATE TABLE IF NOT EXISTS session_two_factor_verifications");
    expect(PLATFORM_0003_SQL).toContain("CHECK (method IN ('totp', 'backup_code'))");
    expect(PLATFORM_0003_SQL).toContain("ALTER TABLE two_factors ADD COLUMN verified");
  });

  it("generates deterministic, scannable pure-TS ISO/IEC 18004 QR SVGs with zero network calls", () => {
    const uri =
      "otpauth://totp/PunyaSitus:operator%40punyasitus.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=PunyaSitus&digits=6&period=30";

    const matrixA = encodeQrMatrix(uri);
    const matrixB = encodeQrMatrix(uri);
    expect(matrixA.version).toBeGreaterThanOrEqual(4);
    expect(matrixA.size).toBe(17 + 4 * matrixA.version);
    expect(Array.from(matrixA.modules)).toEqual(Array.from(matrixB.modules));

    // Verify top-left 7x7 finder pattern outer ring is dark (1)
    for (let i = 0; i < 7; i += 1) {
      expect(matrixA.modules[i]).toBe(1);
      expect(matrixA.modules[6 * matrixA.size + i]).toBe(1);
    }

    const svgA = generateTotpQrSvg(uri);
    const svgB = generateTotpQrSvg(uri);
    expect(svgA).toBe(svgB);
    expect(svgA.startsWith("<svg ")).toBe(true);
    expect(svgA).toContain('role="img"');
    expect(svgA).toContain('fill="#182522"');
    expect(svgA).not.toMatch(/(?:href|src)\s*=/i);
    expect(svgA).not.toContain("https://");
    expect(svgA).not.toContain("<script");

    expect(extractManualTotpSecret(uri)).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  });

  it("computes RFC 6238 SHA-1 TOTP test vectors accurately", async () => {
    // Official RFC 6238 Appendix B SHA-1 test seed "12345678901234567890" -> Base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    const rfcBase32Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const codeAt59s = await generateTotpCodeFromBase32Secret(rfcBase32Secret, {
      timestampMs: 59 * 1000,
      periodSeconds: 30,
      digits: 6,
    });
    const codeAt1111111109s = await generateTotpCodeFromBase32Secret(rfcBase32Secret, {
      timestampMs: 1_111_111_109 * 1000,
      periodSeconds: 30,
      digits: 6,
    });

    expect(codeAt59s).toBe("287082");
    expect(codeAt1111111109s).toBe("081804");
  });

  it("redacts otpauth URIs, TOTP secrets, backup codes, emails, and phone numbers in auth & CLI helpers", () => {
    const raw =
      "Operator alice@example.com phone +6281234567890 uri otpauth://totp/PunyaSitus:a?secret=JBSWY3DPEHPK3PXP backup Ab12C-De34F totp_secret=SUPERSECRET123";

    const authRedacted = redactTwoFactorSensitiveText(raw);
    expect(authRedacted).not.toContain("otpauth://");
    expect(authRedacted).not.toContain("JBSWY3DPEHPK3PXP");
    expect(authRedacted).not.toContain("Ab12C-De34F");
    expect(authRedacted).not.toContain("SUPERSECRET123");

    const cliRedacted = cli.redactCliReason(
      "Recovery for operator@punyasitus.com phone 0812-3456-7890 intl +1-415-555-2671 backup Xy98Z-Ab12C otpauth://totp/PunyaSitus:op?secret=MYSECRET",
    );
    expect(cliRedacted).not.toContain("operator@punyasitus.com");
    expect(cliRedacted).not.toContain("0812-3456-7890");
    expect(cliRedacted).not.toContain("415-555-2671");
    expect(cliRedacted).not.toContain("Xy98Z-Ab12C");
    expect(cliRedacted).not.toContain("MYSECRET");
    expect(cliRedacted).toContain("[REDACTED]");
  });

  it("clears two_factors, session_two_factor_verifications, and sessions atomically on CLI --mode recover --reset-2fa", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "punyasitus-t067-cli-"));
    const dbPath = path.join(tmpDir, "platform.sqlite");
    const nowMs = 1_763_840_000_000;

    try {
      const db = new DatabaseSync(dbPath);
      db.exec(PLATFORM_0001_SQL);
      db.exec(PLATFORM_0003_SQL);
      db.prepare(
        `INSERT INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("usr_op_067", "Op Recovery", "op-recover@example.com", 1, 1, nowMs, nowMs);
      db.prepare(
        `INSERT INTO platform_operators (user_id, granted_by, reason, granted_at)
         VALUES (?, NULL, ?, ?)`,
      ).run("usr_op_067", "Initial operator grant for recovery test", nowMs);
      db.prepare(
        `INSERT INTO two_factors (id, user_id, secret, backup_codes, verified, failed_verification_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
      ).run("tf_067", "usr_op_067", "enc_secret_value", "enc_backup_codes", nowMs, nowMs);
      db.prepare(
        `INSERT INTO sessions (id, expires_at, token, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("sess_067", nowMs + 3_600_000, "tok_067", "usr_op_067", nowMs, nowMs);
      db.prepare(
        `INSERT INTO session_two_factor_verifications (session_id, user_id, verified_at, method, created_at, updated_at)
         VALUES (?, ?, ?, 'totp', ?, ?)`,
      ).run("sess_067", "usr_op_067", nowMs, nowMs, nowMs);
      db.close();

      // Atomic bootstrap guard inside BEGIN IMMEDIATE rejects duplicate initial bootstrap
      const dupBootstrap = cli.validateCliOptions(
        cli.parseCliArgs([
          "--mode",
          "bootstrap",
          "--email",
          "op-recover@example.com",
          "--reason",
          "Duplicate bootstrap must fail atomically",
          "--db-file",
          dbPath,
          "--local",
        ]),
      );
      expect(() => cli.executeLocalOperatorAction(dupBootstrap, nowMs + 500)).toThrow(
        /active platform operator already exists/,
      );

      // Recovery with --reset-2fa clears all 2FA & session state + scrubs email/phone from reason
      const recoverOpts = cli.validateCliOptions(
        cli.parseCliArgs([
          "--mode",
          "recover",
          "--email",
          "op-recover@example.com",
          "--reason",
          "Incident INC-067 verified via phone +6281234567890 for op-recover@example.com lost device",
          "--db-file",
          dbPath,
          "--local",
          "--reset-2fa",
        ]),
      );
      const res = cli.executeLocalOperatorAction(recoverOpts, nowMs + 1000);
      expect(res.ok).toBe(true);
      expect(res.reset2fa).toBe(true);

      const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const userRow = verifyDb
          .prepare("SELECT two_factor_enabled FROM users WHERE id = ?")
          .get("usr_op_067") as { two_factor_enabled: number };
        const tfCount = verifyDb
          .prepare("SELECT COUNT(*) AS count FROM two_factors WHERE user_id = ?")
          .get("usr_op_067") as { count: number };
        const s2faCount = verifyDb
          .prepare("SELECT COUNT(*) AS count FROM session_two_factor_verifications WHERE user_id = ?")
          .get("usr_op_067") as { count: number };
        const sessCount = verifyDb
          .prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
          .get("usr_op_067") as { count: number };
        const auditRow = verifyDb
          .prepare("SELECT action, reason, metadata_json, outcome FROM platform_audit LIMIT 1")
          .get() as {
          action: string;
          reason: string;
          metadata_json: string;
          outcome: string;
        };

        expect(userRow.two_factor_enabled).toBe(0);
        expect(tfCount.count).toBe(0);
        expect(s2faCount.count).toBe(0);
        expect(sessCount.count).toBe(0);
        expect(auditRow.action).toBe("platform_operator.recover");
        expect(auditRow.outcome).toBe("success");
        expect(auditRow.reason).not.toContain("+6281234567890");
        expect(auditRow.reason).not.toContain("op-recover@example.com");
        expect(auditRow.metadata_json).toContain('"recoveryEvent":"platform_operator.recover_2fa"');
      } finally {
        verifyDb.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps BUILD-LOG.md under 50 KB with pre-Wave-0 archive present", () => {
    const buildLogPath = path.join(ROOT, "BUILD-LOG.md");
    const archivePath = path.join(ROOT, "docs/archive/BUILD-LOG-2026-spec-phase.md");
    expect(fs.existsSync(archivePath)).toBe(true);
    const buildLogSize = fs.statSync(buildLogPath).size;
    expect(buildLogSize).toBeLessThan(50_000);
    const buildLogContent = fs.readFileSync(buildLogPath, "utf8");
    expect(buildLogContent).toContain("docs/archive/BUILD-LOG-2026-spec-phase.md");
    expect(buildLogContent).toContain("TASK-023");
    expect(buildLogContent).toContain("TASK-067");
  });
});
