# Platform Operator Access, Bootstrap & Audit Runbook (`REQ-051`, `PLAN §13`, `DEC-021`)

This runbook defines the trusted-environment bootstrap, operator grant/revoke governance, atomic final-operator protection, lost-2FA recovery, and append-only `platform_audit` verification procedures for PunyaSitus.

---

## 1. Authority Model & Non-Negotiable Boundaries

- **Single Source of Platform Authority:** Platform operator privilege is granted exclusively by an active row in `PLATFORM_DB.platform_operators` (`revoked_at IS NULL`) keyed to an authenticated user (`users.id`).
- **Strict Separation from Tenant Roles:** Organization memberships (`members.role` in `owner`, `admin`, `editor`, `agency_staff`, `setup_staff`), client-supplied flags, and email domain suffixes (e.g., `@punyasitus.com`) **never** grant platform access.
- **Live Session + Grant Check on Every Privileged Call:** `requireActivePlatformOperator()` in `packages/auth/src/platform/guard.ts` verifies BOTH:
  1. The session exists in `PLATFORM_DB.sessions`, belongs to `user.id`, and is not expired (revoked sessions fail immediately with `401 SESSION_REVOKED`).
  2. The user currently has `revoked_at IS NULL` in `PLATFORM_DB.platform_operators` (revoked operators fail immediately with `403 OPERATOR_REVOKED` even if they still hold an active session; non-operators fail with `403 PLATFORM_OPERATOR_REQUIRED`).
- **Surface Isolation:** Superadmin routes and APIs are served exclusively on `console.punyasitus.com` (`/api/console/**`), use a separate `__Host-` session cookie boundary, and return `Cache-Control: private, no-store` (never publicly cached).
- **Mandatory Second Factor (`DEC-021`, `REQ-068`):** Every active platform operator must enroll TOTP 2FA (wired centrally by `TASK-067`). Sensitive operations (grant/revoke, tenant state transition, locked domain change, custom theme grant) require recent reauthentication within **10 minutes**.

---

## 2. Trusted-Environment Initial Operator Bootstrap

Bootstrap is executed **only** from a trusted operator environment against an **existing, email-verified user account** (`users.email_verified = 1`). Never create public operator signup routes and never provision default passwords.

### Prerequisites
1. The target human operator has already registered and verified their email address (`users.email_verified = 1` in `PLATFORM_DB`).
2. `PLATFORM_DB` migrations (`0001_initial_platform.sql`) are applied.
3. No active operator currently exists (`SELECT COUNT(*) FROM platform_operators WHERE revoked_at IS NULL` equals `0`).

### Procedure (Local / Synthetic Verification)
Always run `--dry-run` first to validate target email, verification state, and audit reason:

```bash
# 1. Dry-run validation (read-only)
node scripts/platform-operator.mjs \
  --mode bootstrap \
  --email operator@example.com \
  --reason "Initial trusted-environment bootstrap for primary operator" \
  --db-persist .wrangler/state/v3/d1 \
  --local \
  --dry-run

# 2. Execute atomic bootstrap (writes platform_operators + platform_audit in one transaction)
node scripts/platform-operator.mjs \
  --mode bootstrap \
  --email operator@example.com \
  --reason "Initial trusted-environment bootstrap for primary operator" \
  --db-persist .wrangler/state/v3/d1 \
  --local

# 3. Verify active grants (never prints secrets or credentials)
node scripts/platform-operator.mjs \
  --mode list \
  --db-persist .wrangler/state/v3/d1 \
  --local
```

### Guardrails
- Refuses unverified accounts (`users.email_verified = 0`).
- Refuses `--password`, `--default-password`, or `--create-user` flags.
- Refuses bootstrap if an active operator already exists (exit code `2`).
- Refuses `--target production` unless both `--allow-production` and `--confirm-production=CONFIRM_PRODUCTION_OPERATOR_BOOTSTRAP` are passed explicitly (and emits a reviewable plan rather than running an unreviewed remote mutation).

---

## 3. Ongoing Grant & Revoke Operations (Reason + Reauthentication)

Once the initial operator is active, subsequent operator grants and revocations happen through `executeAuditedPlatformGrant()` and `executeAuditedPlatformRevoke()` (surfaced on `console.punyasitus.com/operators` in `TASK-048`):

1. **Active Grant Required:** Acting user must have a live non-revoked session and `revoked_at IS NULL` in `platform_operators`.
2. **Recent Reauthentication Required:** Acting operator must have completed step-up reauthentication within the last **10 minutes** (`DEFAULT_PLATFORM_REAUTH_WINDOW_MS = 600_000`).
3. **Mandatory Audit Reason:** Reason must be **10–500 characters** after trimming and must not contain secrets, tokens, passwords, raw cookies, personal customer messages, or lead bodies.
4. **Atomic Commit + Rollback:** Both `grantPlatformOperator()` and `revokePlatformOperator()` commit the `platform_operators` write and the `platform_audit` insert inside a single `PLATFORM_DB.batch([...])` transaction. If audit persistence fails for any reason, SQLite rolls back the entire batch and no operator state changes.
5. **Immediate Revocation Effect:** Revoking an operator sets `revoked_at`, `revoked_by`, and `revoke_reason`. Because `requireActivePlatformOperator()` rechecks `PLATFORM_DB.platform_operators` on every request, the revoked user is blocked immediately (`403 OPERATOR_REVOKED`) even with an existing active session.

---

## 4. Atomic Final-Operator Protection

To prevent accidental or racing lockouts where zero active operators remain (`PLAN §13`), `revokePlatformOperator()` enforces the invariant atomically in SQL:

```sql
UPDATE platform_operators
SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
WHERE user_id = ?
  AND revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM platform_operators WHERE user_id = ? AND revoked_at IS NULL
  )
  AND (
    SELECT COUNT(*) FROM platform_operators WHERE revoked_at IS NULL
  ) > 1
```

- Paired with `INSERT INTO platform_audit (...) SELECT ... WHERE changes() = 1` inside the same `db.batch([...])`.
- Under concurrent revocations of the final two active operators (`Promise.all([revoke(op1), revoke(op2)])`), SQLite serializes the transactions: the first succeeds (`COUNT(*)` drops from `2` to `1`), and the second matches `0` rows (`COUNT(*) > 1` is false), returning `409 FINAL_OPERATOR_PROTECTED` and recording a `denied` audit entry instead of removing the last active operator.

---

## 5. Lost-2FA & Emergency Operator Recovery

If an operator loses their TOTP authenticator device and all single-use backup codes (`DEC-021`, `PLAN §13`):

1. **Out-of-Band Identity Verification:** Verify the operator's identity through a second trusted channel and record the incident/ticket reference. Never perform silent account takeover.
2. **Audited Trusted-Environment Recovery:** Run `scripts/platform-operator.mjs` in `recover` mode with `--reset-2fa` from a trusted environment:
   ```bash
   node scripts/platform-operator.mjs \
     --mode recover \
     --email operator@example.com \
     --reason "Verified incident INC-2026-001 lost TOTP device recovery and session reset" \
     --db-persist .wrangler/state/v3/d1 \
     --local \
     --reset-2fa
   ```
3. **What `--mode recover --reset-2fa` Atomically Performs:**
   - Ensures the verified operator holds an active `platform_operators` grant.
   - Deletes the operator's row in `two_factors` and resets `users.two_factor_enabled = 0`.
   - Deletes all active rows in `sessions` for that `user_id` so existing cookies are invalidated immediately.
   - Inserts an immutable `platform_operator.recover` entry in `platform_audit` with `actor_role = 'system_recovery'` and the sanitized reason.
4. **Post-Recovery Enrollment:** On next sign-in to `console.punyasitus.com`, the mandatory 2FA gate (`TASK-067`) restricts the operator strictly to the TOTP enrollment flow until a new authenticator and fresh backup codes are enrolled.

---

## 6. Append-Only `platform_audit` Verification & Redaction Guarantees

### Database-Enforced Immutability
`0001_initial_platform.sql` installs two triggers on `platform_audit`:
- `platform_audit_no_update`: `BEFORE UPDATE ON platform_audit` -> `SELECT RAISE(ABORT, 'platform_audit is append-only');`
- `platform_audit_no_delete`: `BEFORE DELETE ON platform_audit` -> `SELECT RAISE(ABORT, 'platform_audit is append-only');`

Runtime roles can only `INSERT` and `SELECT` on `platform_audit`. Any attempt to `UPDATE` or `DELETE` audit rows fails at the SQLite engine level.

### Redaction Rules (`packages/db/src/platform/audit.ts`)
Before any row is prepared for `platform_audit`:
- `reason` and `metadata_json` values are scrubbed for JWTs, `Bearer`/`Basic`/`Token` headers, provider keys (`sk_live_`, `whsec_`, `cf_`, `re_`, `AIza`, `AKIA`, `ghp_`), PEM private keys, `__Host-`/`__Secure-` cookies, emails, phone numbers, and secret key-value pairs.
- Sensitive metadata keys (`password`, `secret`, `token`, `cookie`, `authorization`, `totp`, `backup_codes`, `lead_body`, `customer_message`, `raw_body`, `payload`, `headers`) are unconditionally replaced with `[REDACTED]`.

### Automated Verification Commands
Run inside the repository workspace to verify all `TASK-049` invariants in Node and Cloudflare `workerd`:

```bash
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration
```
