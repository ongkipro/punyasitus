import { z } from "zod";
import {
  EmailSchema,
  IDEMPOTENCY_HEADER_PARAM,
  IsoDateSchema,
  NormalizedPhoneSchema,
  SequentialIdSchema,
  SlugSchema,
  UlidSchema,
  UuidSchema,
  type DomainSchemaModule,
  type RouteContract,
} from "./common.ts";

/**
 * Host-scoped anonymous public endpoints served ONLY on verified tenant hosts
 * (`*.situsku.click` or active custom domain):
 * - POST /api/leads
 * - POST /api/events
 * - POST /api/abuse-report
 *
 * Tenant comes exclusively from the verified request Host; tenant selectors and
 * unknown fields are strictly rejected (PLAN §6, REQ-038, REQ-094).
 */

export const LeadPreferredTimeSchema = z
  .enum(["pagi", "siang", "sore", "malam"])
  .meta({ description: "Preferred contact/schedule window (REQ-072)." });

export const PublicLeadSubmitRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    phone: NormalizedPhoneSchema,
    email: EmailSchema.optional(),
    message: z.string().trim().min(1).max(2000),
    formSlug: SlugSchema.optional(),
    customFields: z
      .record(z.string().min(1).max(64), z.union([z.string().max(500), z.boolean()]))
      .refine((obj) => Object.keys(obj).length <= 12, {
        message: "Custom forms may submit at most 12 fields (PLAN §5.2)",
      })
      .optional(),
    preferred_date: IsoDateSchema.optional(),
    preferred_time: LeadPreferredTimeSchema.optional(),
    branch: SequentialIdSchema.optional(),
    sourcePath: z
      .string()
      .startsWith("/")
      .max(200)
      .refine((p) => !p.includes("?"), "sourcePath must not contain query strings")
      .optional(),
    honeypot: z.literal("").optional(),
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .meta({
    description:
      "Host-scoped anonymous visitor lead submission (max 16 KiB body; tenant resolved from Host only; PLAN §6).",
  });

export const PublicLeadSubmitResponseSchema = z
  .object({
    leadNumber: SequentialIdSchema,
    status: z.literal("accepted"),
    confirmationMessage: z.string().min(1).max(500),
    redirectUrl: z.string().max(2048).optional(),
  })
  .strict()
  .meta({ description: "Durable lead acceptance response returned only after TenantStore commit." });

export const CanonicalEventNameSchema = z
  .enum(["wa_click", "external_click", "lead_submitted", "page_view"])
  .meta({ description: "First-party canonical conversion/engagement event name (PLAN §7.3)." });

const PII_IN_PATH_PATTERN =
  /(@|[?&]|(?:^|[^0-9])(?:\+?62|0)8[0-9]{7,12}(?:$|[^0-9])|[0-9]{10,})/;

export const PublicEventIngestRequestSchema = z
  .object({
    eventId: UuidSchema,
    eventName: CanonicalEventNameSchema,
    path: z
      .string()
      .startsWith("/")
      .max(200)
      .refine((value) => !PII_IN_PATH_PATTERN.test(value), {
        message: "Event path must not contain query strings, emails, or phone numbers (no PII)",
      }),
    targetKind: z
      .enum([
        "page",
        "post",
        "service",
        "product",
        "tour",
        "vehicle",
        "outlet",
        "header",
        "floating_wa",
      ])
      .optional(),
    targetSlug: SlugSchema.optional(),
    sourceCategory: z
      .enum(["direct", "search", "social", "ai_assistant", "referral", "campaign"])
      .optional(),
    consentVersion: z.string().min(1).max(32).optional(),
  })
  .strict()
  .meta({
    description:
      "Host-scoped anonymous event ingestion payload. Strictly rejects PII fields (email, phone, name, query strings) and unknown fields (PLAN §6, REQ-038, REQ-039).",
  });

export const AbuseCategorySchema = z
  .enum(["phishing", "scam", "malware", "impersonation", "illegal_content", "spam", "other"])
  .meta({ description: "Closed abuse report category (REQ-094)." });

export const PublicAbuseReportRequestSchema = z
  .object({
    category: AbuseCategorySchema,
    reportedPath: z
      .string()
      .startsWith("/")
      .max(200)
      .refine((p) => !p.includes("?"), "reportedPath must not include query strings"),
    description: z.string().trim().min(10).max(2000),
    reporterEmail: EmailSchema.optional(),
    turnstileToken: z.string().min(1).max(2048),
  })
  .strict()
  .meta({
    description:
      "Host-scoped anonymous abuse report routed to platform moderation queue (REQ-094; rejects tenantId).",
  });

export const PublicAbuseReportResponseSchema = z
  .object({
    reportId: UlidSchema,
    status: z.literal("received"),
  })
  .strict();

export const LEADS_EVENTS_ROUTES: readonly RouteContract[] = [
  {
    path: "/api/leads",
    method: "post",
    operationId: "publicSubmitLead",
    tag: "Leads & Events",
    summary: "Submit a host-scoped anonymous visitor lead (built-in or custom form)",
    description:
      "Served exclusively on verified tenant hosts. Tenant is resolved from verified Host header; tenantId fields are rejected. Supports JSON (201) and progressive-enhancement form POST (303).",
    surface: "tenant",
    auth: "anonymous_tenant_host",
    requiredRoles: [],
    parameters: [IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "PublicLeadSubmitRequest",
    requestBodyContentTypes: ["application/json", "application/x-www-form-urlencoded"],
    successStatus: 201,
    successSchemaId: "PublicLeadSubmitResponse",
    errorStatuses: [400, 403, 404, 409, 413, 415, 422, 429, 503],
    rateLimited: true,
    idempotent: true,
  },
  {
    path: "/api/events",
    method: "post",
    operationId: "publicIngestEvent",
    tag: "Leads & Events",
    summary: "Ingest a cookieless PII-free first-party analytics event on a tenant host",
    description:
      "Served exclusively on verified tenant hosts. Over-limit events are dropped cleanly with 204; malformed/PII/unknown-field payloads are rejected with 422.",
    surface: "tenant",
    auth: "anonymous_tenant_host",
    requiredRoles: [],
    requestBodySchemaId: "PublicEventIngestRequest",
    successStatus: 204,
    errorStatuses: [400, 403, 404, 413, 415, 422, 503],
    rateLimited: true,
  },
  {
    path: "/api/abuse-report",
    method: "post",
    operationId: "publicSubmitAbuseReport",
    tag: "Leads & Events",
    summary: "Submit a host-scoped abuse report against a tenant site (REQ-094)",
    surface: "tenant",
    auth: "anonymous_tenant_host",
    requiredRoles: [],
    requestBodySchemaId: "PublicAbuseReportRequest",
    successStatus: 201,
    successSchemaId: "PublicAbuseReportResponse",
    errorStatuses: [400, 403, 404, 413, 415, 422, 429, 503],
    rateLimited: true,
  },
];

export const LEADS_EVENTS_DOMAIN_MODULE: DomainSchemaModule = {
  schemas: {
    LeadPreferredTime: LeadPreferredTimeSchema,
    PublicLeadSubmitRequest: PublicLeadSubmitRequestSchema,
    PublicLeadSubmitResponse: PublicLeadSubmitResponseSchema,
    CanonicalEventName: CanonicalEventNameSchema,
    PublicEventIngestRequest: PublicEventIngestRequestSchema,
    AbuseCategory: AbuseCategorySchema,
    PublicAbuseReportRequest: PublicAbuseReportRequestSchema,
    PublicAbuseReportResponse: PublicAbuseReportResponseSchema,
  },
  routes: LEADS_EVENTS_ROUTES,
};
