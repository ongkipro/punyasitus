# PunyaSitus Staged Release, Rollback & Status Page Runbook

> Contract authority: `PRD.md` (`REQ-106`, `REQ-041`, `REQ-042`), `PLAN.md` (§5.2, §9, §20.3).
> Related runbooks: [Telemetry & Alerting](./telemetry-release.md) | [Backup, Restore Drill & Tombstone Replay](./backup-restore.md) | [Hosting & Topology](./hosting.md).

---

## 1. Release Model Overview

PunyaSitus deploys two completely decoupled artifacts:

1. **Platform Worker (`apps/web` -> `punyasitus-web`)**: Uses **Cloudflare Gradual Deployments** (`wrangler versions upload` followed by progressive `wrangler versions deploy` splits) for standard backward-compatible releases, and **`wrangler deploy`** strictly when a release includes a `TenantStore` Durable Object migration.
2. **Standalone Static Status Page (`apps/status` -> `punyasitus-status`)**: Built as a zero-binding static site on a separate host (`status.punyasitus.com`, Cloudflare Pages) with **zero dependency on `punyasitus-web`, D1, R2, Queues, or `TenantStore`**. It stays reachable even during a total platform Worker outage.

---

## 2. Pre-Release Mandatory Gates (CI & Migration Discipline)

Before uploading a new production Worker version:

1. **CI Verification Gate (frozen lockfile, zero production credentials):**
   ```bash
   pnpm spec:check
   pnpm lint
   pnpm typecheck
   pnpm test:unit
   pnpm test:integration
   pnpm build
   ```
2. **Staged Release CI Dry-Run:**
   - `.github/workflows/staged-release-dry-run.yml` validates the independent `apps/status` static build and executes `wrangler versions upload --dry-run` on `apps/web/dist/server/wrangler.json` without deploying traffic.
3. **Version-Skew & Expand-Contract Rule (Mandatory for Gradual Deployments):**
   - During a 10% or 50% gradual rollout, sequential requests from the **same user browser session** can land on different Worker versions (`<previous-version-id>` and `<new-version-id>`).
   - Every HTTP response shape, cookie/session format, D1 query, and Queue job payload **must remain backward-compatible for at least one full release**.
   - Every `PLATFORM_DB` D1 migration (`packages/db/migrations/platform/*.sql`) must be **strictly additive** (new tables, new nullable/defaulted columns, new indexes). Never drop or rename columns in the same release that still serves traffic on the previous version.
   - Apply additive `PLATFORM_DB` migrations using dedicated migration credentials *before* shifting traffic to the new version (for example, apply `0007_platform_incidents.sql` prior to releasing Worker versions that read or write `platform_incidents`):
     ```bash
     cd apps/web
     pnpm exec wrangler d1 migrations apply punyasitus-platform --remote
     ```

---

## 3. Standard Staged Release Procedure (Cloudflare Gradual Deployments)

Use this procedure for all releases that do **NOT** modify `TenantStore` Durable Object schema or `wrangler.jsonc` Durable Object `migrations`.

> **Operational note (Cloudflare Gradual Deployments):** Cloudflare gradual deployments operate on the **last 100 uploaded versions** of the Worker. Always record both `<previous-version-id>` and `<new-version-id>` before shifting traffic.

### Step 1 — Record the Currently Active Version
```bash
cd apps/web
pnpm exec wrangler versions list
```
Save the active 100% version UUID as `<previous-version-id>`.

### Step 2 — Build & Upload the Candidate Version (0% Traffic)
```bash
pnpm --filter @punyasitus/web build
cd apps/web
pnpm exec wrangler versions upload \
  --config dist/server/wrangler.json \
  --message "release: <git-sha> <short-summary>"
```
Record the newly returned UUID as `<new-version-id>`. Uploading a version does **not** route any live traffic to it.

### Step 3 — Stage 1: 10% Canary Rollout
```bash
cd apps/web
pnpm exec wrangler versions deploy \
  <previous-version-id>@90% \
  <new-version-id>@10% \
  --yes
```
Observe for **at least 15 minutes**:
- `GET https://app.punyasitus.com/api/health` (`200 ok`)
- `GET https://app.punyasitus.com/api/health/db` (`200 ok`)
- `GET https://app.punyasitus.com/api/health/jobs` (`status: "ok"`, zero dead-letter spike)
- `GET https://app.punyasitus.com/api/health/backup` (`freshness: "ok"`)
- Canary tenant host (`https://canary.situsku.click/` -> `200`, unknown host -> neutral `404`)
- Cloudflare Workers Logs & Traces: HTTP `5xx` error rate `< 1%`, zero unexpected exceptions or version-skew serialization errors.

### Step 4 — Stage 2: 50% Ramp Rollout
Only proceed when Stage 1 metrics stay green for 15 minutes:
```bash
cd apps/web
pnpm exec wrangler versions deploy \
  <previous-version-id>@50% \
  <new-version-id>@50% \
  --yes
```
Observe for **at least 15 minutes** across admin, console, public tenant SSR, and Queue consumers.

### Step 5 — Stage 3: 100% Full Rollout
Only proceed when Stage 2 metrics stay green:
```bash
cd apps/web
pnpm exec wrangler versions deploy \
  <new-version-id>@100% \
  --yes
```
Continue monitoring `/api/health/*` and error rates for 15 minutes post-promotion.

---

## 4. Mandatory `TenantStore` Durable Object Migration Rule

**CRITICAL RULE (`PLAN.md` §5.2 & §20.3):**
Only **one** Durable Object version runs at a time per class in Cloudflare Workers. **You CANNOT use gradual `wrangler versions deploy` traffic splits across a `TenantStore` Durable Object migration.**

Whenever a release includes **either**:
- A new `TenantStore` SQLite schema migration (`packages/db/migrations/tenant/*.sql`), **or**
- A Wrangler Durable Object `migrations` entry in `apps/web/wrangler.jsonc`:

Follow this mandatory sequence:

1. **Backward-Compatible Expand-Contract Only:**
   - Every `TenantStore` migration must be strictly additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` with defaults/nullable).
2. **Pre-Migration PITR Bookmarking (`PLAN.md` §5.2):**
   - `TenantStore` automatically captures and persists a SQLite Point-in-Time Recovery bookmark in `PLATFORM_DB.migration_bookmarks` (`status = 'pending'`) **before** executing any tenant DDL, marking it `applied` only after commit.
   - Verify an isolated restore drill ([backup-restore.md](./backup-restore.md) §3) passes on staging before production.
3. **Apply with `wrangler deploy` (NOT `wrangler versions deploy`):**
   ```bash
   pnpm --filter @punyasitus/web build
   cd apps/web
   pnpm exec wrangler deploy --config dist/server/wrangler.json
   ```
4. **Post-Deploy Verification:**
   - Immediately probe `/api/health`, `/api/health/db`, `/api/health/jobs`, and `canary.situsku.click`.
   - Confirm `migration_bookmarks` shows `status = 'applied'` with zero `failed` rows.

---

## 5. Exact Rollback Procedures

### 5.1 Immediate Rollback During or After a Gradual Rollout
If `5xx` rate exceeds `1%`, dead-letter jobs spike, or a regression is confirmed during 10%, 50%, or 100% rollout:

```bash
cd apps/web
pnpm exec wrangler versions deploy <previous-version-id>@100% --yes
```
Alternative shorthand to revert directly to the immediately prior deployment:
```bash
cd apps/web
pnpm exec wrangler rollback --yes
```

**Post-rollback checklist:**
1. Verify `wrangler versions list` confirms `<previous-version-id>` is serving `100%`.
2. Re-run `/api/health`, `/api/health/db`, `/api/health/jobs`, and `canary.situsku.click`.
3. **Leave additive D1 schema intact** — NEVER run destructive down-migrations (`DROP TABLE` / `DROP COLUMN`).
4. If customers experienced user-visible impact, declare or update an incident via `console.punyasitus.com/incidents` and update `status.punyasitus.com`.

### 5.2 Rollback Safety Caveats for `TenantStore` Durable Object Migrations
- Because `TenantStore` migrations are strictly additive and applied with `wrangler deploy`, rolling back application code to a previous compatible version works **only if** the previous Worker version ignores the new columns/tables and does not reject the newer `_tenant_migrations` version.
- **NEVER execute destructive SQL down-migrations** against `TenantStore`.
- If a `TenantStore` migration caused logical corruption on specific tenants:
  1. Declare an incident on `console.punyasitus.com/incidents` (activates dashboard banner) and publish on `status.punyasitus.com`.
  2. Follow [backup-restore.md](./backup-restore.md) to restore affected `TenantStore` instances using their pre-migration PITR bookmark (`restore(bookmark)`) recorded in `PLATFORM_DB.migration_bookmarks`.
  3. Execute mandatory `replayDeletionTombstones` after any restore so deleted tenants/data are never resurrected.
  4. Ship an audited forward-fix via `wrangler deploy` once verified in staging.

---

## 6. Independent Status Page Deployment & Incident Banner SOP

### 6.1 Independent Static Build & Publish (`apps/status`)
The status page (`apps/status`) has **zero bindings** to `punyasitus-web`, `PLATFORM_DB`, `TENANT_STORE`, R2, or Queues.

1. Edit `apps/status/public/status.json` to reflect component status (`operational`, `degraded`, `partial_outage`, `major_outage`) and incident updates.
2. Build static output independently:
   ```bash
   pnpm --dir apps/status build
   ```
   Output is generated in `apps/status/dist/` (`index.html`, `status.json`, `styles.css`, `app.js`, `_headers`).
3. Deploy independently to Cloudflare Pages (explicit operator authorization required):
   ```bash
   pnpm exec wrangler pages deploy apps/status/dist --project-name punyasitus-status
   ```
4. Confirm `https://status.punyasitus.com` renders with JavaScript disabled (build-time SSR fallback) and returns `200 OK` independently of `app.punyasitus.com`.

### 6.2 In-Dashboard Incident Banner (`console.punyasitus.com/incidents`)
1. Operator signs in to `console.punyasitus.com` with verified 2FA (step-up `< 10` minutes).
2. Open `/console/incidents` -> submit **Deklarasikan Insiden & Aktifkan Banner** (single audited operator action -> writes `platform_incidents`, `platform_incident_updates`, and immutable `platform_audit` atomically).
3. All signed-in tenant dashboards immediately display the sanitized Indonesian incident banner linking to `https://status.punyasitus.com`.
4. Once recovery is verified, click **Selesaikan Insiden** -> confirm -> banner disappears immediately and resolution is recorded atomically in `platform_audit`.
