import { and, desc, eq } from "drizzle-orm";
import { normalizeHost } from "@punyasitus/core";
import { createSqliteDrizzle } from "../connections/platform-db.ts";
import {
  abuseReports,
  billingObligations,
  migrationBookmarks,
  paymentAttempts,
  platformSchema,
  receipts,
  serviceRequests,
  tenantHosts,
  tenants,
} from "./schema.ts";

export class CrossTenantAccessError extends Error {
  readonly status = 404 as const;
  readonly code = "NOT_FOUND" as const;
  readonly expectedTenantId: string;
  readonly attemptedTenantId: string;

  constructor(expectedTenantId: string, attemptedTenantId: string) {
    super("Tenant resource not found");
    this.name = "CrossTenantAccessError";
    this.expectedTenantId = expectedTenantId;
    this.attemptedTenantId = attemptedTenantId;
  }
}

export interface TenantScope {
  readonly tenantId: string;
}

/**
 * Narrow server-only `PLATFORM_DB` repository strictly bound to one verified `tenantId`.
 * Every query enforces `tenant_id = scope.tenantId` in SQL so cross-tenant reads return
 * `null` / empty sets and explicit tenant-ID mismatches reject with `CrossTenantAccessError`.
 */
export function createTenantScopedPlatformRepo(platformDb: D1Database, scope: TenantScope) {
  const tenantId = scope.tenantId.trim();
  if (!tenantId) {
    throw new Error("TENANT_SCOPE_REQUIRED: non-empty tenantId is required");
  }
  const db = createSqliteDrizzle(platformDb, platformSchema);

  return {
    readonlyTenantId: tenantId,

    assertTenantOwnership(requestedTenantId: string): void {
      if (requestedTenantId !== tenantId) {
        throw new CrossTenantAccessError(tenantId, requestedTenantId);
      }
    },

    async getTenant() {
      const rows = await db
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return rows[0] ?? null;
    },

    async listHosts() {
      return db.select().from(tenantHosts).where(eq(tenantHosts.tenantId, tenantId));
    },

    async getHost(rawHost: string) {
      const normalized = normalizeHost(rawHost);
      if (!normalized) return null;
      const rows = await db
        .select()
        .from(tenantHosts)
        .where(and(eq(tenantHosts.host, normalized), eq(tenantHosts.tenantId, tenantId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async listMigrationBookmarks() {
      return db
        .select()
        .from(migrationBookmarks)
        .where(eq(migrationBookmarks.tenantId, tenantId))
        .orderBy(desc(migrationBookmarks.createdAt));
    },

    async getMigrationBookmarkById(bookmarkId: string) {
      const rows = await db
        .select()
        .from(migrationBookmarks)
        .where(
          and(eq(migrationBookmarks.id, bookmarkId), eq(migrationBookmarks.tenantId, tenantId)),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async listBillingObligations() {
      return db
        .select()
        .from(billingObligations)
        .where(eq(billingObligations.tenantId, tenantId))
        .orderBy(desc(billingObligations.createdAt));
    },

    async getBillingObligationById(obligationId: string) {
      const rows = await db
        .select()
        .from(billingObligations)
        .where(
          and(
            eq(billingObligations.id, obligationId),
            eq(billingObligations.tenantId, tenantId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async getPaymentAttemptById(attemptId: string) {
      const rows = await db
        .select()
        .from(paymentAttempts)
        .where(
          and(eq(paymentAttempts.id, attemptId), eq(paymentAttempts.tenantId, tenantId)),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async getReceiptById(receiptId: string) {
      const rows = await db
        .select()
        .from(receipts)
        .where(and(eq(receipts.id, receiptId), eq(receipts.tenantId, tenantId)))
        .limit(1);
      return rows[0] ?? null;
    },

    async getServiceRequestById(requestId: string) {
      const rows = await db
        .select()
        .from(serviceRequests)
        .where(
          and(eq(serviceRequests.id, requestId), eq(serviceRequests.tenantId, tenantId)),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async getAbuseReportById(reportId: string) {
      const rows = await db
        .select()
        .from(abuseReports)
        .where(and(eq(abuseReports.id, reportId), eq(abuseReports.tenantId, tenantId)))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

/**
 * Authoritative edge host resolution (`tenant_hosts JOIN tenants`) from `PLATFORM_DB`.
 * Never trusts client-supplied tenant IDs or `X-Forwarded-Host`.
 */
export async function resolveHostRecord(platformDb: D1Database, rawHost: string) {
  const normalized = normalizeHost(rawHost);
  if (!normalized) return null;
  const db = createSqliteDrizzle(platformDb, platformSchema);
  const rows = await db
    .select({
      host: tenantHosts.host,
      hostStatus: tenantHosts.status,
      sslStatus: tenantHosts.sslStatus,
      isPrimary: tenantHosts.isPrimary,
      kind: tenantHosts.kind,
      tenantId: tenants.id,
      handle: tenants.handle,
      name: tenants.name,
      tenantStatus: tenants.status,
      operatorHold: tenants.operatorHold,
      cacheVersion: tenants.cacheVersion,
      schemaVersion: tenants.schemaVersion,
    })
    .from(tenantHosts)
    .innerJoin(tenants, eq(tenantHosts.tenantId, tenants.id))
    .where(eq(tenantHosts.host, normalized))
    .limit(1);
  return rows[0] ?? null;
}
