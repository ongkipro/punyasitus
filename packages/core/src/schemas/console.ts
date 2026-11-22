import { z } from "zod";
import {
  createPaginatedResponseSchema,
  EmailSchema,
  HostnameSchema,
  IDEMPOTENCY_HEADER_PARAM,
  IsoDatetimeSchema,
  SequentialIdSchema,
  TENANT_HANDLE_PATH_PARAM,
  TenantHandleSchema,
  TenantStatusSchema,
  ThemeIdSchema,
  UlidSchema,
  UuidSchema,
  VersionSchema,
  type DomainSchemaModule,
  type RouteContract,
} from "./common.ts";
import { DomainConnectModeSchema, DomainRecordSchema } from "./domains.ts";
import { AbuseCategorySchema } from "./leads-events.ts";

/**
 * Superadmin console schemas served exclusively on `console.punyasitus.com` (`/api/console/**`).
 * Requires active `platform_operators` grant + mandatory TOTP + distinct `__Host-` cookie.
 * Every mutation requires a 10-500 char reason, expectedVersion, and idempotencyKey (PLAN §13).
 */

export const OperatorReasonSchema = z
  .string()
  .trim()
  .min(10)
  .max(500)
  .meta({
    description: "Mandatory operator audit reason (10-500 chars; no secrets or personal messages).",
  });

export const OperatorGrantRecordSchema = z
  .object({
    userId: UlidSchema,
    email: EmailSchema,
    grantedByUserId: UlidSchema,
    grantedAt: IsoDatetimeSchema,
    revokedAt: IsoDatetimeSchema.nullable(),
    totpEnrolled: z.boolean(),
    version: VersionSchema,
  })
  .strict();

export const OperatorGrantListResponseSchema = createPaginatedResponseSchema(
  OperatorGrantRecordSchema,
  "Paginated list of active and revoked platform operator grants.",
);

export const OperatorGrantCreateRequestSchema = z
  .object({
    targetUserId: UlidSchema,
    reason: OperatorReasonSchema,
    expectedVersion: VersionSchema,
    idempotencyKey: UuidSchema,
  })
  .strict()
  .meta({ description: "Grant platform operator role (requires recent 2FA reauthentication)." });

export const OperatorGrantRevokeRequestSchema = z
  .object({
    reason: OperatorReasonSchema,
    expectedVersion: VersionSchema,
    idempotencyKey: UuidSchema,
  })
  .strict()
  .meta({
    description:
      "Revoke an operator grant (atomically prevents removing the final active operator; PLAN §13).",
  });

export const ConsoleTenantSummarySchema = z
  .object({
    id: UlidSchema,
    handle: TenantHandleSchema,
    name: z.string().min(1).max(160),
    status: TenantStatusSchema,
    operatorHold: z.boolean(),
    primaryHost: z.string().min(4).max(253),
    ownerEmail: EmailSchema,
    trialEndsAt: IsoDatetimeSchema.nullable(),
    paidThrough: IsoDatetimeSchema.nullable(),
    version: VersionSchema,
    createdAt: IsoDatetimeSchema,
  })
  .strict()
  .meta({
    description:
      "Narrow control-plane tenant summary from PLATFORM_DB (never reads TenantStore content/leads).",
  });

export const ConsoleTenantListResponseSchema = createPaginatedResponseSchema(
  ConsoleTenantSummarySchema,
  "Paginated directory of tenants in PLATFORM_DB.",
);

export const ConsoleTenantCreateRequestSchema = z
  .object({
    handle: TenantHandleSchema,
    name: z.string().trim().min(1).max(160),
    ownerEmail: EmailSchema,
    initialStatus: z.enum(["trial", "active"]),
    reason: OperatorReasonSchema,
    idempotencyKey: UuidSchema,
  })
  .strict()
  .meta({ description: "Audited operator tenant provisioning request." });

export const ConsoleTenantStateActionRequestSchema = z
  .object({
    action: z.enum(["suspend_hold", "release_hold", "enter_recovery", "start_purge"]),
    reason: OperatorReasonSchema,
    expectedVersion: VersionSchema,
    idempotencyKey: UuidSchema,
  })
  .strict()
  .meta({
    description:
      "Audited tenant service-state action (releasing hold recomputes entitlement; never grants free active time; PLAN §13).",
  });

export const ConsoleTenantThemeGrantRequestSchema = z
  .object({
    themeId: ThemeIdSchema,
    action: z.enum(["grant", "revoke"]),
    reason: OperatorReasonSchema,
    expectedVersion: VersionSchema,
    idempotencyKey: UuidSchema,
  })
  .strict()
  .meta({ description: "Grant or revoke custom theme availability for a tenant." });

export const ConsoleDomainSummarySchema = z
  .object({
    tenantHandle: TenantHandleSchema,
    domain: DomainRecordSchema,
  })
  .strict();

export const ConsoleDomainListResponseSchema = createPaginatedResponseSchema(
  ConsoleDomainSummarySchema,
  "Paginated cross-tenant custom domain monitoring list.",
);

export const ConsoleDomainRecheckRequestSchema = z
  .object({
    tenantHandle: TenantHandleSchema,
    reason: OperatorReasonSchema,
    expectedVersion: VersionSchema,
    idempotencyKey: UuidSchema,
  })
  .strict()
  .meta({ description: "Operator-triggered rate-limited domain reconciliation (no force-active)." });

export const ConsoleDomainChangeRequestSchema = z
  .object({
    tenantHandle: TenantHandleSchema,
    removeDomainId: SequentialIdSchema.optional(),
    connectHostname: HostnameSchema.optional(),
    mode: DomainConnectModeSchema.optional(),
    reason: OperatorReasonSchema,
    expectedVersion: VersionSchema,
    idempotencyKey: UuidSchema,
  })
  .strict()
  .refine((val) => val.removeDomainId !== undefined || val.connectHostname !== undefined, {
    message: "Specify removeDomainId and/or connectHostname for an operator domain change",
  })
  .meta({
    description:
      "Operator-assisted removal or replacement of a locked active custom domain (REQ-065, PLAN §13).",
  });

export const ConsoleJobSummarySchema = z
  .object({
    jobId: UlidSchema,
    kind: z.string().min(1).max(80),
    tenantHandle: TenantHandleSchema.nullable(),
    state: z.enum(["queued", "running", "succeeded", "failed", "dead_letter"]),
    attempts: z.number().int().min(0),
    maxAttempts: z.number().int().min(1),
    failureCode: z.string().max(80).nullable(),
    leasedUntil: IsoDatetimeSchema.nullable(),
    version: VersionSchema,
    updatedAt: IsoDatetimeSchema,
  })
  .strict();

export const ConsoleJobListResponseSchema = createPaginatedResponseSchema(
  ConsoleJobSummarySchema,
  "Paginated platform durable job queue list.",
);

export const ConsoleJobRetryRequestSchema = z
  .object({
    reason: OperatorReasonSchema,
    expectedVersion: VersionSchema,
    idempotencyKey: UuidSchema,
  })
  .strict()
  .meta({ description: "Retry an eligible failed job using its original validated parameters." });

export const ModerationStatusSchema = z.enum(["open", "reviewing", "actioned", "dismissed"]);

export const ConsoleAbuseReportSummarySchema = z
  .object({
    reportId: UlidSchema,
    tenantHandle: TenantHandleSchema,
    category: AbuseCategorySchema,
    reportedPath: z.string().startsWith("/").max(200),
    status: ModerationStatusSchema,
    version: VersionSchema,
    createdAt: IsoDatetimeSchema,
  })
  .strict();

export const ConsoleAbuseReportListResponseSchema = createPaginatedResponseSchema(
  ConsoleAbuseReportSummarySchema,
  "Paginated abuse moderation queue (REQ-094).",
);

export const ConsoleAbuseModerationActionRequestSchema = z
  .object({
    status: z.enum(["reviewing", "actioned", "dismissed"]),
    applyOperatorHold: z.boolean(),
    reason: OperatorReasonSchema,
    expectedVersion: VersionSchema,
    idempotencyKey: UuidSchema,
  })
  .strict()
  .meta({ description: "Resolve or triage an abuse report with optional audited operator hold." });

export const ConsoleBillingRecheckRequestSchema = z
  .object({
    tenantHandle: TenantHandleSchema,
    attemptId: UlidSchema,
    reason: OperatorReasonSchema,
    expectedVersion: VersionSchema,
    idempotencyKey: UuidSchema,
  })
  .strict()
  .meta({
    description:
      "Audited operator AutoLaris Advice recheck (never allows typing an arbitrary paid status; PLAN §16.3).",
  });

export const ConsoleAuditEntrySchema = z
  .object({
    auditId: UlidSchema,
    actorUserId: UlidSchema,
    action: z.string().min(1).max(120),
    targetKind: z.string().min(1).max(64),
    targetId: z.string().min(1).max(120),
    reason: z.string().min(1).max(500),
    outcome: z.enum(["succeeded", "denied", "failed"]),
    requestId: z.string().min(1).max(128),
    createdAt: IsoDatetimeSchema,
  })
  .strict();

export const ConsoleAuditListResponseSchema = createPaginatedResponseSchema(
  ConsoleAuditEntrySchema,
  "Paginated append-only platform audit log.",
);

export const ConsoleHealthResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded", "unknown"]),
    failedJobsCount: z.number().int().min(0).nullable(),
    stuckDomainsCount: z.number().int().min(0).nullable(),
    lastBackupAt: IsoDatetimeSchema.nullable(),
    lastRestoreDrillAt: IsoDatetimeSchema.nullable(),
    checkedAt: IsoDatetimeSchema,
  })
  .strict()
  .meta({
    description: "Read-only operational readiness snapshot (unknown is null, never fabricated zero).",
  });

const USER_ID_PATH_PARAM = {
  name: "userId",
  in: "path" as const,
  required: true,
  description: "Operator user ULID.",
  schema: UlidSchema,
};

const CONSOLE_DOMAIN_ID_PATH_PARAM = {
  name: "domainId",
  in: "path" as const,
  required: true,
  description: "Custom domain sequential ID.",
  schema: SequentialIdSchema,
};

const JOB_ID_PATH_PARAM = {
  name: "jobId",
  in: "path" as const,
  required: true,
  description: "Durable job ULID.",
  schema: UlidSchema,
};

const REPORT_ID_PATH_PARAM = {
  name: "reportId",
  in: "path" as const,
  required: true,
  description: "Abuse report ULID.",
  schema: UlidSchema,
};

export const CONSOLE_ROUTES: readonly RouteContract[] = [
  {
    path: "/api/console/tenants",
    method: "get",
    operationId: "consoleListTenants",
    tag: "Console",
    summary: "List and search tenants in PLATFORM_DB directory",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:tenants:read",
    successStatus: 200,
    successSchemaId: "ConsoleTenantListResponse",
    errorStatuses: [401, 403, 503],
  },
  {
    path: "/api/console/tenants",
    method: "post",
    operationId: "consoleCreateTenant",
    tag: "Console",
    summary: "Atomically provision a new tenant (audited)",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:tenants:provision",
    parameters: [IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "ConsoleTenantCreateRequest",
    successStatus: 201,
    successSchemaId: "ConsoleTenantSummary",
    errorStatuses: [400, 401, 403, 409, 415, 422, 503],
    idempotent: true,
  },
  {
    path: "/api/console/tenants/{tenantId}",
    method: "get",
    operationId: "consoleGetTenant",
    tag: "Console",
    summary: "Read control-plane summary for a single tenant",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:tenants:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "ConsoleTenantSummary",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/console/tenants/{tenantId}/state",
    method: "post",
    operationId: "consoleChangeTenantState",
    tag: "Console",
    summary: "Apply or release operator hold / recovery / purge state (reauth required)",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:tenants:state",
    parameters: [TENANT_HANDLE_PATH_PARAM, IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "ConsoleTenantStateActionRequest",
    successStatus: 200,
    successSchemaId: "ConsoleTenantSummary",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
    idempotent: true,
  },
  {
    path: "/api/console/tenants/{tenantId}/themes",
    method: "post",
    operationId: "consoleManageTenantThemeGrant",
    tag: "Console",
    summary: "Grant or revoke custom theme availability for a tenant (reauth required)",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:themes:grant",
    parameters: [TENANT_HANDLE_PATH_PARAM, IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "ConsoleTenantThemeGrantRequest",
    successStatus: 200,
    successSchemaId: "ConsoleTenantSummary",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
    idempotent: true,
  },
  {
    path: "/api/console/domains",
    method: "get",
    operationId: "consoleListDomains",
    tag: "Console",
    summary: "List custom hostnames across tenants for reconciliation monitoring",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:domains:manage",
    successStatus: 200,
    successSchemaId: "ConsoleDomainListResponse",
    errorStatuses: [401, 403, 503],
  },
  {
    path: "/api/console/domains/{domainId}/recheck",
    method: "post",
    operationId: "consoleRecheckDomain",
    tag: "Console",
    summary: "Trigger rate-limited provider domain reconciliation",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:domains:manage",
    parameters: [CONSOLE_DOMAIN_ID_PATH_PARAM, IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "ConsoleDomainRecheckRequest",
    successStatus: 200,
    successSchemaId: "ConsoleDomainSummary",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 429, 503],
    rateLimited: true,
    idempotent: true,
  },
  {
    path: "/api/console/domains/change",
    method: "post",
    operationId: "consoleChangeLockedDomain",
    tag: "Console",
    summary: "Remove or replace an active locked tenant custom domain (reauth required)",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "domain:remove_active",
    parameters: [IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "ConsoleDomainChangeRequest",
    successStatus: 200,
    successSchemaId: "ConsoleDomainSummary",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
    idempotent: true,
  },
  {
    path: "/api/console/jobs",
    method: "get",
    operationId: "consoleListJobs",
    tag: "Console",
    summary: "List durable job states and safe failure codes",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:jobs:retry",
    successStatus: 200,
    successSchemaId: "ConsoleJobListResponse",
    errorStatuses: [401, 403, 503],
  },
  {
    path: "/api/console/jobs/{jobId}/retry",
    method: "post",
    operationId: "consoleRetryJob",
    tag: "Console",
    summary: "Retry an eligible failed job without modifying its validated payload",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:jobs:retry",
    parameters: [JOB_ID_PATH_PARAM, IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "ConsoleJobRetryRequest",
    successStatus: 200,
    successSchemaId: "ConsoleJobSummary",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
    idempotent: true,
  },
  {
    path: "/api/console/moderation/abuse-reports",
    method: "get",
    operationId: "consoleListAbuseReports",
    tag: "Console",
    summary: "List incoming host-scoped abuse reports",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:moderation:resolve",
    successStatus: 200,
    successSchemaId: "ConsoleAbuseReportListResponse",
    errorStatuses: [401, 403, 503],
  },
  {
    path: "/api/console/moderation/abuse-reports/{reportId}/resolve",
    method: "post",
    operationId: "consoleResolveAbuseReport",
    tag: "Console",
    summary: "Resolve an abuse report and optionally place tenant on operator hold",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:moderation:resolve",
    parameters: [REPORT_ID_PATH_PARAM, IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "ConsoleAbuseModerationActionRequest",
    successStatus: 200,
    successSchemaId: "ConsoleAbuseReportSummary",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
    idempotent: true,
  },
  {
    path: "/api/console/operators",
    method: "get",
    operationId: "consoleListOperators",
    tag: "Console",
    summary: "List active and revoked platform operator grants",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:operators:manage",
    successStatus: 200,
    successSchemaId: "OperatorGrantListResponse",
    errorStatuses: [401, 403, 503],
  },
  {
    path: "/api/console/operators",
    method: "post",
    operationId: "consoleGrantOperator",
    tag: "Console",
    summary: "Grant platform operator role (reauth required)",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:operators:manage",
    parameters: [IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "OperatorGrantCreateRequest",
    successStatus: 201,
    successSchemaId: "OperatorGrantRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
    idempotent: true,
  },
  {
    path: "/api/console/operators/{userId}/revoke",
    method: "post",
    operationId: "consoleRevokeOperator",
    tag: "Console",
    summary: "Revoke an operator grant atomically (preserves final active operator)",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:operators:manage",
    parameters: [USER_ID_PATH_PARAM, IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "OperatorGrantRevokeRequest",
    successStatus: 200,
    successSchemaId: "OperatorGrantRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
    idempotent: true,
  },
  {
    path: "/api/console/billing/recheck",
    method: "post",
    operationId: "consoleRecheckBilling",
    tag: "Console",
    summary: "Request an audited AutoLaris Advice settlement recheck for a tenant attempt",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:billing:recheck",
    parameters: [IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "ConsoleBillingRecheckRequest",
    successStatus: 200,
    successSchemaId: "BillingRecheckResponse",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 429, 503],
    rateLimited: true,
    idempotent: true,
  },
  {
    path: "/api/console/audit",
    method: "get",
    operationId: "consoleListAuditLog",
    tag: "Console",
    summary: "Read append-only platform audit entries",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:audit:read",
    successStatus: 200,
    successSchemaId: "ConsoleAuditListResponse",
    errorStatuses: [401, 403, 503],
  },
  {
    path: "/api/console/health",
    method: "get",
    operationId: "consoleGetHealth",
    tag: "Console",
    summary: "Read operational readiness and backup/restore evidence timestamps",
    surface: "console",
    auth: "console_session",
    requiredRoles: ["platform_operator"],
    requiredPermission: "console:health:read",
    successStatus: 200,
    successSchemaId: "ConsoleHealthResponse",
    errorStatuses: [401, 403, 503],
  },
];

export const CONSOLE_DOMAIN_MODULE: DomainSchemaModule = {
  schemas: {
    OperatorReason: OperatorReasonSchema,
    OperatorGrantRecord: OperatorGrantRecordSchema,
    OperatorGrantListResponse: OperatorGrantListResponseSchema,
    OperatorGrantCreateRequest: OperatorGrantCreateRequestSchema,
    OperatorGrantRevokeRequest: OperatorGrantRevokeRequestSchema,
    ConsoleTenantSummary: ConsoleTenantSummarySchema,
    ConsoleTenantListResponse: ConsoleTenantListResponseSchema,
    ConsoleTenantCreateRequest: ConsoleTenantCreateRequestSchema,
    ConsoleTenantStateActionRequest: ConsoleTenantStateActionRequestSchema,
    ConsoleTenantThemeGrantRequest: ConsoleTenantThemeGrantRequestSchema,
    ConsoleDomainSummary: ConsoleDomainSummarySchema,
    ConsoleDomainListResponse: ConsoleDomainListResponseSchema,
    ConsoleDomainRecheckRequest: ConsoleDomainRecheckRequestSchema,
    ConsoleDomainChangeRequest: ConsoleDomainChangeRequestSchema,
    ConsoleJobSummary: ConsoleJobSummarySchema,
    ConsoleJobListResponse: ConsoleJobListResponseSchema,
    ConsoleJobRetryRequest: ConsoleJobRetryRequestSchema,
    ModerationStatus: ModerationStatusSchema,
    ConsoleAbuseReportSummary: ConsoleAbuseReportSummarySchema,
    ConsoleAbuseReportListResponse: ConsoleAbuseReportListResponseSchema,
    ConsoleAbuseModerationActionRequest: ConsoleAbuseModerationActionRequestSchema,
    ConsoleBillingRecheckRequest: ConsoleBillingRecheckRequestSchema,
    ConsoleAuditEntry: ConsoleAuditEntrySchema,
    ConsoleAuditListResponse: ConsoleAuditListResponseSchema,
    ConsoleHealthResponse: ConsoleHealthResponseSchema,
  },
  routes: CONSOLE_ROUTES,
};
