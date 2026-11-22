import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  generatePlatformAuditId,
  MAX_OPERATOR_REASON_LENGTH,
  MIN_OPERATOR_REASON_LENGTH,
  PlatformAuditError,
  preparePlatformAuditRecord,
  redactAuditMetadata,
  redactAuditText,
  serializeAuditMetadata,
  validateOperatorReason,
} from "@punyasitus/db/platform";
import { beforeAll, describe, expect, it } from "vitest";

interface ParsedCliArgs {
  readonly mode: string | null;
  readonly email: string | null;
  readonly reason: string | null;
  readonly dbPersist: string | null;
  readonly dbFile: string | null;
  readonly target: string;
  readonly local: boolean;
  readonly allowAdditional: boolean;
  readonly allowProduction: boolean;
  readonly confirmProduction: string | null;
  readonly reset2fa: boolean;
  readonly requestId: string | null;
  readonly dryRun: boolean;
  readonly help: boolean;
}

interface ValidatedCliOptions extends ParsedCliArgs {
  readonly requestId: string;
}

interface LocalOperatorActionResult {
  readonly ok: boolean;
  readonly dryRun?: boolean;
  readonly mode: string;
  readonly sqlitePath: string;
  readonly userId?: string;
  readonly action?: string;
  readonly auditId?: string;
  readonly requestId?: string;
  readonly reason?: string | null;
  readonly reset2fa?: boolean;
  readonly operators?: ReadonlyArray<{
    readonly userId: string;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly twoFactorEnabled: boolean;
    readonly isActive: boolean;
  }>;
}

interface PlatformOperatorCliModule {
  readonly CliValidationError: new (message: string) => Error;
  readonly PRODUCTION_CONFIRM_TOKEN: string;
  readonly parseCliArgs: (argv: readonly string[]) => ParsedCliArgs;
  readonly validateCliOptions: (raw: ParsedCliArgs) => ValidatedCliOptions;
  readonly executeLocalOperatorAction: (
    options: ValidatedCliOptions,
    nowMs?: number,
  ) => LocalOperatorActionResult;
}

const ROOT = path.resolve(import.meta.dirname, "../..");
const PLATFORM_SQL = fs.readFileSync(
  path.join(ROOT, "packages/db/migrations/platform/0001_initial_platform.sql"),
  "utf8",
);

let CliValidationError: PlatformOperatorCliModule["CliValidationError"];
let PRODUCTION_CONFIRM_TOKEN: string;
let parseCliArgs: PlatformOperatorCliModule["parseCliArgs"];
let validateCliOptions: PlatformOperatorCliModule["validateCliOptions"];
let executeLocalOperatorAction: PlatformOperatorCliModule["executeLocalOperatorAction"];

describe("TASK-049 unit checks — reason validation, audit redaction & operator CLI", () => {
  beforeAll(async () => {
    const cliUrl = pathToFileURL(path.join(ROOT, "scripts/platform-operator.mjs")).href;
    const mod = (await import(cliUrl)) as PlatformOperatorCliModule;
    CliValidationError = mod.CliValidationError;
    PRODUCTION_CONFIRM_TOKEN = mod.PRODUCTION_CONFIRM_TOKEN;
    parseCliArgs = mod.parseCliArgs;
    validateCliOptions = mod.validateCliOptions;
    executeLocalOperatorAction = mod.executeLocalOperatorAction;
  });
  it("generates Crockford Base32 ULIDs compatible with ConsoleAuditEntrySchema", () => {
    const id = generatePlatformAuditId(1_763_830_000_000);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const id2 = generatePlatformAuditId(1_763_830_000_000);
    expect(id2).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id2).not.toBe(id);
  });

  it("enforces PLAN §13 operator reason length bounds (10-500 chars)", () => {
    expect(() => validateOperatorReason(undefined)).toThrow(PlatformAuditError);
    expect(() => validateOperatorReason("short")).toThrow(/at least 10/);
    expect(() => validateOperatorReason("   123456789   ")).toThrow(/at least 10/);
    expect(() => validateOperatorReason("x".repeat(MAX_OPERATOR_REASON_LENGTH + 1))).toThrow(
      /at most 500/,
    );

    const exactMin = "a".repeat(MIN_OPERATOR_REASON_LENGTH);
    expect(validateOperatorReason(exactMin)).toBe(exactMin);

    const exactMax = "b".repeat(MAX_OPERATOR_REASON_LENGTH);
    expect(validateOperatorReason(exactMax)).toBe(exactMax);
  });

  it("redacts secrets, tokens, passwords, raw cookies, emails, phones, and PEM blocks in audit text", () => {
    const dirty = [
      "Bootstrap incident:",
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.signature1234567890",
      "password=SuperSecretPass123",
      "__Host-punyasitus_console_session=raw-cookie-val-999",
      "api_key=sk_live_0123456789abcdef",
      "totp_secret=JBSWY3DPEHPK3PXP",
      "contact ops@example.com or +6281234567890",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ==\n-----END PRIVATE KEY-----",
    ].join(" ");

    const cleaned = redactAuditText(dirty);
    expect(cleaned).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(cleaned).not.toContain("SuperSecretPass123");
    expect(cleaned).not.toContain("raw-cookie-val-999");
    expect(cleaned).not.toContain("sk_live_0123456789abcdef");
    expect(cleaned).not.toContain("JBSWY3DPEHPK3PXP");
    expect(cleaned).not.toContain("ops@example.com");
    expect(cleaned).not.toContain("6281234567890");
    expect(cleaned).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQ");
    expect(cleaned).toContain("[REDACTED]");

    // Preserves normal operational words starting with "re"/"cf" while redacting re_/cf_ keys
    const operational = redactAuditText(
      "req_boot_001 reauthentication revocation re_secretKey12345 cf_tokenValue98765",
    );
    expect(operational).toContain("req_boot_001");
    expect(operational).toContain("reauthentication");
    expect(operational).toContain("revocation");
    expect(operational).not.toContain("re_secretKey12345");
    expect(operational).not.toContain("cf_tokenValue98765");
  });

  it("deeply redacts sensitive keys including lead bodies, cookies, tokens, and backup codes in audit metadata", () => {
    const redacted = redactAuditMetadata({
      mode: "recovery",
      password: "do-not-store-password",
      accessToken: "tok_secret_value_12345",
      rawCookie: "__Host-punyasitus_session=abc123",
      leadBody: "Halo saya mau pesan 100 unit alamat Jl Sudirman No 1",
      customer_message: "Personal customer inquiry message",
      totpSeed: "BASE32SEEDXYZ",
      backupCodes: ["CODE-1111", "CODE-2222"],
      nested: {
        authorization: "Bearer secret_token_abc123",
        safeFlag: true,
        note: "Contains email leaked@example.com",
      },
      err: new Error("Bearer secret_err_token_123456"),
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("do-not-store-password");
    expect(serialized).not.toContain("tok_secret_value_12345");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("Jl Sudirman");
    expect(serialized).not.toContain("Personal customer inquiry");
    expect(serialized).not.toContain("BASE32SEEDXYZ");
    expect(serialized).not.toContain("CODE-1111");
    expect(serialized).not.toContain("secret_token_abc123");
    expect(serialized).not.toContain("leaked@example.com");
    expect(serialized).not.toContain("secret_err_token_123456");

    expect(redacted).toMatchObject({
      mode: "recovery",
      password: "[REDACTED]",
      accessToken: "[REDACTED]",
      rawCookie: "[REDACTED]",
      leadBody: "[REDACTED]",
      customer_message: "[REDACTED]",
      totpSeed: "[REDACTED]",
      backupCodes: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        safeFlag: true,
        note: "Contains email [REDACTED]",
      },
    });

    // Oversized metadata is safely truncated without leaking payloads
    const huge: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) {
      huge[`field_${i}`] = "z".repeat(250);
    }
    const serializedHuge = serializeAuditMetadata(huge);
    expect(serializedHuge).toBeTruthy();
    expect(serializedHuge!.length).toBeLessThanOrEqual(4096);
  });

  it("prepares validated platform_audit rows and rejects invalid outcomes", () => {
    const row = preparePlatformAuditRecord({
      actorUserId: "usr_op_1",
      actorRole: "platform_operator",
      action: "platform_operator.grant",
      targetType: "platform_operator",
      targetId: "usr_op_2",
      reason: "Granting secondary operator for on-call rotation",
      requireReason: true,
      outcome: "success",
      requestId: "req_12345",
      metadata: { reactivated: false, leadBody: "must redact" },
      createdAtMs: 1_763_830_000_000,
    });

    expect(row.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(row.outcome).toBe("success");
    expect(row.requestId).toBe("req_12345");
    expect(row.metadataJson).toContain('"[REDACTED]"');
    expect(row.metadataJson).not.toContain("must redact");

    expect(() =>
      preparePlatformAuditRecord({
        actorRole: "platform_operator",
        action: "platform_operator.grant",
        targetType: "platform_operator",
        targetId: "usr_op_2",
        outcome: "invalid" as "success",
      }),
    ).toThrow(PlatformAuditError);
  });

  it("validates scripts/platform-operator.mjs CLI flags and rejects insecure or unconfirmed flags", () => {
    // Rejects default-password / user-creation flags
    expect(() =>
      parseCliArgs(["--mode", "bootstrap", "--password", "admin123"]),
    ).toThrow(CliValidationError);
    expect(() => parseCliArgs(["--mode", "bootstrap", "--create-user"])).toThrow(
      CliValidationError,
    );
    expect(() => parseCliArgs(["--unknown-flag", "1"])).toThrow(CliValidationError);

    // Rejects missing / short reason
    expect(() =>
      validateCliOptions(
        parseCliArgs([
          "--mode",
          "bootstrap",
          "--email",
          "op@example.com",
          "--reason",
          "short",
          "--db-persist",
          "/tmp/d1",
          "--local",
        ]),
      ),
    ).toThrow(/between 10 and 500/);

    // Rejects --reset-2fa outside recover mode
    expect(() =>
      validateCliOptions(
        parseCliArgs([
          "--mode",
          "bootstrap",
          "--email",
          "op@example.com",
          "--reason",
          "Valid bootstrap reason for local test",
          "--db-persist",
          "/tmp/d1",
          "--reset-2fa",
        ]),
      ),
    ).toThrow(/only permitted with --mode recover/);

    // Rejects production target without explicit dual confirmation flags
    expect(() =>
      validateCliOptions(
        parseCliArgs([
          "--mode",
          "bootstrap",
          "--email",
          "op@example.com",
          "--reason",
          "Valid bootstrap reason for prod check",
          "--target",
          "production",
        ]),
      ),
    ).toThrow(/Refusing production target/);

    // Accepts production target ONLY with explicit dual confirmation (plan-only)
    const prodOpts = validateCliOptions(
      parseCliArgs([
        "--mode",
        "bootstrap",
        "--email",
        "OP@Example.com",
        "--reason",
        "Approved production bootstrap incident INC-001",
        "--target",
        "production",
        "--allow-production",
        `--confirm-production=${PRODUCTION_CONFIRM_TOKEN}`,
      ]),
    );
    expect(prodOpts.email).toBe("op@example.com");
    expect(prodOpts.target).toBe("production");
  });

  it("executes local bootstrap, dry-run, and lost-2FA recovery atomically against a migrated SQLite DB", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "punyasitus-t049-cli-"));
    const dbPath = path.join(tmpDir, "platform.sqlite");
    const nowMs = 1_763_830_000_000;

    try {
      const seedDb = new DatabaseSync(dbPath);
      seedDb.exec(PLATFORM_SQL);
      seedDb
        .prepare(
          `INSERT INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("usr_verified_cli", "Primary Op", "primary-op@example.com", 1, 1, nowMs, nowMs);
      seedDb
        .prepare(
          `INSERT INTO users (id, name, email, email_verified, two_factor_enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("usr_unverified_cli", "Unverified Op", "unverified-op@example.com", 0, 0, nowMs, nowMs);
      seedDb
        .prepare(
          `INSERT INTO two_factors (id, user_id, secret, backup_codes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("tf_1", "usr_verified_cli", "encrypted-totp-secret", "hashed-codes", nowMs, nowMs);
      seedDb
        .prepare(
          `INSERT INTO sessions (id, expires_at, token, user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("sess_cli_1", nowMs + 3_600_000, "tok_cli_1", "usr_verified_cli", nowMs, nowMs);
      seedDb.close();

      // 1. Refuses unverified account
      const unverifiedOpts = validateCliOptions(
        parseCliArgs([
          "--mode",
          "bootstrap",
          "--email",
          "unverified-op@example.com",
          "--reason",
          "Should fail because email is unverified",
          "--db-persist",
          tmpDir,
          "--local",
        ]),
      );
      expect(() => executeLocalOperatorAction(unverifiedOpts, nowMs)).toThrow(
        /not email-verified/,
      );

      // 2. Dry-run does not mutate database
      const dryRunOpts = validateCliOptions(
        parseCliArgs([
          "--mode",
          "bootstrap",
          "--email",
          "primary-op@example.com",
          "--reason",
          "Initial trusted-environment local bootstrap test",
          "--db-persist",
          tmpDir,
          "--local",
          "--dry-run",
        ]),
      );
      const dryRes = executeLocalOperatorAction(dryRunOpts, nowMs);
      expect(dryRes.dryRun).toBe(true);

      const listAfterDry = executeLocalOperatorAction(
        validateCliOptions(parseCliArgs(["--mode", "list", "--db-persist", tmpDir, "--local"])),
        nowMs,
      );
      expect(listAfterDry.operators).toHaveLength(0);

      // 3. Live bootstrap creates active operator + audit entry
      const bootOpts = validateCliOptions(
        parseCliArgs([
          "--mode",
          "bootstrap",
          "--email",
          "primary-op@example.com",
          "--reason",
          "Initial trusted-environment local bootstrap test",
          "--db-persist",
          tmpDir,
          "--local",
        ]),
      );
      const bootRes = executeLocalOperatorAction(bootOpts, nowMs);
      expect(bootRes.ok).toBe(true);
      expect(bootRes.userId).toBe("usr_verified_cli");

      // 4. Second bootstrap without recovery is refused
      expect(() => executeLocalOperatorAction(bootOpts, nowMs + 1000)).toThrow(
        /active platform operator already exists/,
      );

      // 5. Recovery with --reset-2fa clears two_factors, sessions, sets two_factor_enabled = 0, and audits
      const recoverOpts = validateCliOptions(
        parseCliArgs([
          "--mode",
          "recover",
          "--email",
          "primary-op@example.com",
          "--reason",
          "Verified incident INC-049 lost TOTP authenticator recovery",
          "--db-persist",
          tmpDir,
          "--local",
          "--reset-2fa",
        ]),
      );
      const recoverRes = executeLocalOperatorAction(recoverOpts, nowMs + 2000);
      expect(recoverRes.ok).toBe(true);
      expect(recoverRes.reset2fa).toBe(true);

      const checkDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const userRow = checkDb
          .prepare("SELECT two_factor_enabled FROM users WHERE id = ?")
          .get("usr_verified_cli") as { two_factor_enabled: number };
        const tfCount = checkDb
          .prepare("SELECT COUNT(*) AS count FROM two_factors WHERE user_id = ?")
          .get("usr_verified_cli") as { count: number };
        const sessCount = checkDb
          .prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
          .get("usr_verified_cli") as { count: number };
        const audits = checkDb
          .prepare("SELECT action, outcome FROM platform_audit ORDER BY created_at ASC")
          .all() as Array<{ action: string; outcome: string }>;

        expect(userRow.two_factor_enabled).toBe(0);
        expect(tfCount.count).toBe(0);
        expect(sessCount.count).toBe(0);
        expect(audits).toEqual([
          { action: "platform_operator.bootstrap", outcome: "success" },
          { action: "platform_operator.recover", outcome: "success" },
        ]);
      } finally {
        checkDb.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
