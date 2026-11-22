import { z } from "zod";
import {
  HostnameSchema,
  IDEMPOTENCY_HEADER_PARAM,
  IsoDatetimeSchema,
  SequentialIdSchema,
  TENANT_HANDLE_PATH_PARAM,
  VersionSchema,
  type DomainSchemaModule,
  type RouteContract,
} from "./common.ts";

/**
 * Custom domain connect, verification recheck, primary switch, and safe removal
 * schemas (PLAN §3, §3.1, §3.2, REQ-043, REQ-065).
 */

export const DomainConnectModeSchema = z
  .enum(["new_domain", "zero_downtime_migration", "cloudflare_o2o"])
  .meta({
    description:
      "Three CNAME connect modes chosen by the owner's live-site situation (PLAN §3.2, DEC-040).",
  });

export const DomainStatusSchema = z
  .enum(["requested", "pending_verification", "pending_ssl", "active", "failed", "disabled"])
  .meta({ description: "Authoritative custom domain lifecycle state (PLAN §3)." });

export const DomainSslStatusSchema = z
  .enum(["pending_validation", "pending_issuance", "active", "expired", "failed", "deleted"])
  .meta({ description: "Separate certificate DCV status tracked independently of ownership." });

export const DomainSslMethodSchema = z
  .enum(["http", "txt"])
  .meta({ description: "Cloudflare for SaaS certificate validation method." });

export const DomainValidationRecordSchema = z
  .object({
    recordType: z.enum(["CNAME", "TXT"]),
    name: z.string().min(1).max(255),
    value: z.string().min(1).max(1024),
    purpose: z.enum(["ownership", "ssl_dcv", "routing"]),
    status: z.enum(["pending", "verified", "conflict", "expired"]),
    removableAfterActive: z.boolean(),
  })
  .strict()
  .meta({
    description:
      "Provider-derived DNS instruction record; tokens and targets are never fabricated client-side.",
  });

export const DomainRecordSchema = z
  .object({
    id: SequentialIdSchema,
    hostname: z.string().min(4).max(253),
    kind: z.enum(["subdomain", "custom"]),
    mode: DomainConnectModeSchema.nullable(),
    status: DomainStatusSchema,
    sslStatus: DomainSslStatusSchema,
    dnsTargetObserved: z.string().max(253).nullable(),
    httpsProbePassed: z.boolean(),
    isPrimary: z.boolean(),
    isLocked: z.boolean(),
    failureCode: z.string().max(80).nullable(),
    lastCheckedAt: IsoDatetimeSchema.nullable(),
    tokenExpiresAt: IsoDatetimeSchema.nullable(),
    validationRecords: z.array(DomainValidationRecordSchema).max(6),
    version: VersionSchema,
  })
  .strict()
  .meta({ description: "Tenant domain binding and provider verification status." });

export const DomainListResponseSchema = z
  .object({
    items: z.array(DomainRecordSchema).max(3),
    customDomainLocked: z.boolean(),
    maxCustomHostnames: z.literal(2),
  })
  .strict()
  .meta({
    description:
      "Tenant domain list (1 platform fallback + up to 2 custom hostnames; REQ-065).",
  });

export const DomainConnectRequestSchema = z
  .object({
    hostname: HostnameSchema,
    mode: DomainConnectModeSchema,
    sslMethod: DomainSslMethodSchema.optional(),
    confirmApexFlattening: z.boolean().optional(),
  })
  .strict()
  .meta({
    description:
      "Connect a custom hostname to a paid tenant (trial tenants refused; rejects tenantId).",
  });

export const DomainRecheckRequestSchema = z
  .object({
    version: VersionSchema,
  })
  .strict()
  .meta({ description: "Rate-limited manual verification recheck trigger (PLAN §3.2)." });

export const DomainPrimarySwitchRequestSchema = z
  .object({
    version: VersionSchema,
  })
  .strict()
  .meta({
    description:
      "Promote an active, SSL-active, HTTPS-probe-verified hostname to tenant primary (PLAN §3.1).",
  });

export const DomainRemoveRequestSchema = z
  .object({
    confirmHostname: HostnameSchema,
    version: VersionSchema,
  })
  .strict()
  .meta({
    description:
      "Safe removal confirmation naming the exact hostname (owner before activation only; operator after).",
  });

const DOMAIN_ID_PATH_PARAM = {
  name: "domainId",
  in: "path" as const,
  required: true,
  description: "Per-tenant sequential domain record ID.",
  schema: SequentialIdSchema,
};

export const DOMAIN_ROUTES: readonly RouteContract[] = [
  {
    path: "/api/tenants/{tenantId}/domains",
    method: "get",
    operationId: "tenantListDomains",
    tag: "Domains",
    summary: "List platform fallback and custom domains for a tenant",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "agency_admin"],
    requiredPermission: "domain:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "DomainListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/domains",
    method: "post",
    operationId: "tenantConnectDomain",
    tag: "Domains",
    summary: "Connect a custom hostname (paid tenants only, owner/agency)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "domain:connect",
    parameters: [TENANT_HANDLE_PATH_PARAM, IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "DomainConnectRequest",
    successStatus: 201,
    successSchemaId: "DomainRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 429, 503],
    rateLimited: true,
    idempotent: true,
  },
  {
    path: "/api/tenants/{tenantId}/domains/{domainId}/recheck",
    method: "post",
    operationId: "tenantRecheckDomain",
    tag: "Domains",
    summary: "Trigger a rate-limited DNS/SSL verification recheck",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "domain:recheck",
    parameters: [TENANT_HANDLE_PATH_PARAM, DOMAIN_ID_PATH_PARAM],
    requestBodySchemaId: "DomainRecheckRequest",
    successStatus: 200,
    successSchemaId: "DomainRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 429, 503],
    rateLimited: true,
  },
  {
    path: "/api/tenants/{tenantId}/domains/{domainId}/make-primary",
    method: "post",
    operationId: "tenantMakePrimaryDomain",
    tag: "Domains",
    summary: "Transactionally switch the tenant primary domain to an active verified hostname",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "domain:make_primary",
    parameters: [TENANT_HANDLE_PATH_PARAM, DOMAIN_ID_PATH_PARAM],
    requestBodySchemaId: "DomainPrimarySwitchRequest",
    successStatus: 200,
    successSchemaId: "DomainRecord",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/domains/{domainId}",
    method: "delete",
    operationId: "tenantRemoveInactiveDomain",
    tag: "Domains",
    summary: "Safely remove a never-activated custom hostname (locked once active per REQ-065)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "domain:remove_inactive",
    parameters: [TENANT_HANDLE_PATH_PARAM, DOMAIN_ID_PATH_PARAM],
    requestBodySchemaId: "DomainRemoveRequest",
    successStatus: 204,
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
];

export const DOMAINS_DOMAIN_MODULE: DomainSchemaModule = {
  schemas: {
    DomainConnectMode: DomainConnectModeSchema,
    DomainStatus: DomainStatusSchema,
    DomainSslStatus: DomainSslStatusSchema,
    DomainSslMethod: DomainSslMethodSchema,
    DomainValidationRecord: DomainValidationRecordSchema,
    DomainRecord: DomainRecordSchema,
    DomainListResponse: DomainListResponseSchema,
    DomainConnectRequest: DomainConnectRequestSchema,
    DomainRecheckRequest: DomainRecheckRequestSchema,
    DomainPrimarySwitchRequest: DomainPrimarySwitchRequestSchema,
    DomainRemoveRequest: DomainRemoveRequestSchema,
  },
  routes: DOMAIN_ROUTES,
};
