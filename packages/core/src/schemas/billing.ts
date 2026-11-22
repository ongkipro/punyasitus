import { z } from "zod";
import {
  createPaginatedResponseSchema,
  HttpsUrlSchema,
  IDEMPOTENCY_HEADER_PARAM,
  IdrAmountSchema,
  IsoDatetimeSchema,
  TENANT_HANDLE_PATH_PARAM,
  TenantStatusSchema,
  UlidSchema,
  UuidSchema,
  VersionSchema,
  type DomainSchemaModule,
  type RouteContract,
} from "./common.ts";

/**
 * AutoLaris platform subscription billing schemas (PLAN §16, §17, REQ-056..058, REQ-081..082).
 * Payer-only endpoints (owner or agency payer); client-supplied prices and provider IDs
 * are strictly rejected. Only QRIS and bank Virtual Account channels are permitted.
 */

export const BillingPlanSchema = z
  .enum(["monthly", "yearly"])
  .meta({ description: "Platform subscription period (1 calendar month or 12 calendar months)." });

export const PaymentChannelKindSchema = z
  .enum(["QRIS", "VA"])
  .meta({
    description:
      "Allowed AutoLaris payment channel families (strictly QRIS and bank Virtual Account; PLAN §16.2).",
  });

export const BillingObligationStateSchema = z
  .enum(["open", "paid", "cancelled", "expired", "review"])
  .meta({ description: "Platform subscription billing obligation status." });

export const PaymentAttemptStateSchema = z
  .enum(["creating", "creation_unknown", "pending", "expired", "failed", "paid", "review"])
  .meta({ description: "Local AutoLaris payment attempt state machine (PLAN §16.3)." });

export const PaymentChannelOptionSchema = z
  .object({
    code: z.string().min(1).max(40),
    label: z.string().min(1).max(100),
    kind: PaymentChannelKindSchema,
    estimatedFeeIdr: IdrAmountSchema,
    enabled: z.boolean(),
  })
  .strict()
  .meta({ description: "Server-validated enabled AutoLaris QRIS/VA channel." });

export const PaymentChannelListResponseSchema = z
  .object({
    channels: z.array(PaymentChannelOptionSchema).max(50),
    monthlyBasePriceIdr: IdrAmountSchema,
    yearlyBasePriceIdr: IdrAmountSchema,
    currency: z.literal("IDR"),
    taxNotice: z.string().min(1).max(160),
  })
  .strict();

export const CouponApplyRequestSchema = z
  .object({
    couponCode: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .regex(/^[A-Z0-9_-]+$/, "Coupon code must be uppercase alphanumeric with hyphens/underscores"),
    plan: BillingPlanSchema,
  })
  .strict()
  .meta({
    description: "Preview single-coupon discount against authoritative server plan price (REQ-082).",
  });

export const CouponPreviewResponseSchema = z
  .object({
    couponCode: z.string().min(2).max(40),
    plan: BillingPlanSchema,
    baseAmountIdr: IdrAmountSchema,
    discountAmountIdr: IdrAmountSchema,
    netAmountIdr: IdrAmountSchema,
    currency: z.literal("IDR"),
    taxNotice: z.string().min(1).max(160),
  })
  .strict();

export const CheckoutAttemptCreateRequestSchema = z
  .object({
    plan: BillingPlanSchema,
    channelKind: PaymentChannelKindSchema,
    channelCode: z.string().min(1).max(40),
    couponCode: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .regex(/^[A-Z0-9_-]+$/)
      .optional(),
    idempotencyKey: UuidSchema,
  })
  .strict()
  .meta({
    description:
      "Create a serialized AutoLaris QRIS/VA payment attempt (rejects client-supplied amounts, provider IDs, or tenantId; PLAN §16.4).",
  });

export const CheckoutInstructionSchema = z
  .object({
    attemptId: UlidSchema,
    obligationId: UlidSchema,
    reffId: z.string().min(4).max(80),
    plan: BillingPlanSchema,
    channelKind: PaymentChannelKindSchema,
    channelCode: z.string().min(1).max(40),
    state: PaymentAttemptStateSchema,
    baseAmountIdr: IdrAmountSchema,
    discountAmountIdr: IdrAmountSchema,
    channelFeeIdr: IdrAmountSchema,
    totalPayableIdr: IdrAmountSchema,
    currency: z.literal("IDR"),
    taxNotice: z.string().min(1).max(160),
    qrisPayload: z.string().max(4096).nullable(),
    vaNumber: z.string().max(64).nullable(),
    bankName: z.string().max(80).nullable(),
    paymentRedirectUrl: HttpsUrlSchema.nullable(),
    expiresAt: IsoDatetimeSchema.nullable(),
    createdAt: IsoDatetimeSchema,
  })
  .strict()
  .meta({
    description:
      "AutoLaris checkout payment instructions returned to the payer (private/no-store; PLAN §16.4).",
  });

export const BillingObligationSummarySchema = z
  .object({
    obligationId: UlidSchema,
    plan: BillingPlanSchema,
    payerKind: z.enum(["tenant", "agency"]),
    state: BillingObligationStateSchema,
    baseAmountIdr: IdrAmountSchema,
    discountAmountIdr: IdrAmountSchema,
    netAmountIdr: IdrAmountSchema,
    currency: z.literal("IDR"),
    periodStartAt: IsoDatetimeSchema.nullable(),
    periodEndAt: IsoDatetimeSchema.nullable(),
    version: VersionSchema,
    createdAt: IsoDatetimeSchema,
  })
  .strict();

export const BillingSummaryResponseSchema = z
  .object({
    tenantStatus: TenantStatusSchema,
    trialEndsAt: IsoDatetimeSchema.nullable(),
    paidThrough: IsoDatetimeSchema.nullable(),
    graceEndsAt: IsoDatetimeSchema.nullable(),
    lockedEndsAt: IsoDatetimeSchema.nullable(),
    deletionDueAt: IsoDatetimeSchema.nullable(),
    activeObligation: BillingObligationSummarySchema.nullable(),
    noRefundNotice: z.string().min(1).max(300),
  })
  .strict()
  .meta({ description: "Owner/payer subscription status and active billing obligation summary." });

export const BillingRecheckResponseSchema = z
  .object({
    attemptId: UlidSchema,
    state: PaymentAttemptStateSchema,
    checkedAt: IsoDatetimeSchema,
  })
  .strict();

export const ReceiptSummarySchema = z
  .object({
    receiptId: UlidSchema,
    receiptNumber: z.string().min(4).max(64),
    obligationId: UlidSchema,
    issuedAt: IsoDatetimeSchema,
    baseAmountIdr: IdrAmountSchema,
    discountAmountIdr: IdrAmountSchema,
    channelFeeIdr: IdrAmountSchema,
    totalPaidIdr: IdrAmountSchema,
    currency: z.literal("IDR"),
    taxNotice: z.string().min(1).max(160),
    isCreditNote: z.boolean(),
    downloadPath: z.string().startsWith("/api/tenants/").max(256),
  })
  .strict()
  .meta({ description: "Immutable numbered PDF payment receipt summary (REQ-081)." });

export const ReceiptListResponseSchema = createPaginatedResponseSchema(
  ReceiptSummarySchema,
  "Paginated list of numbered PDF receipts for the scoped tenant.",
);

const ATTEMPT_ID_PATH_PARAM = {
  name: "attemptId",
  in: "path" as const,
  required: true,
  description: "Payment attempt ULID.",
  schema: UlidSchema,
};

export const BILLING_ROUTES: readonly RouteContract[] = [
  {
    path: "/api/tenants/{tenantId}/billing",
    method: "get",
    operationId: "tenantGetBillingSummary",
    tag: "Billing",
    summary: "Read tenant subscription state, deadlines, and active billing obligation",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "billing:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "BillingSummaryResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/billing/channels",
    method: "get",
    operationId: "tenantListBillingChannels",
    tag: "Billing",
    summary: "List enabled AutoLaris QRIS and bank Virtual Account channels",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "billing:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "PaymentChannelListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/billing/coupons/preview",
    method: "post",
    operationId: "tenantPreviewBillingCoupon",
    tag: "Billing",
    summary: "Validate and preview a single coupon discount before checkout",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "billing:pay",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    requestBodySchemaId: "CouponApplyRequest",
    successStatus: 200,
    successSchemaId: "CouponPreviewResponse",
    errorStatuses: [400, 401, 403, 404, 415, 422, 429, 503],
    rateLimited: true,
  },
  {
    path: "/api/tenants/{tenantId}/billing/attempts",
    method: "post",
    operationId: "tenantCreateBillingAttempt",
    tag: "Billing",
    summary: "Create a durable AutoLaris QRIS/VA payment attempt",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "billing:pay",
    parameters: [TENANT_HANDLE_PATH_PARAM, IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "CheckoutAttemptCreateRequest",
    successStatus: 201,
    successSchemaId: "CheckoutInstruction",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 429, 503],
    rateLimited: true,
    idempotent: true,
  },
  {
    path: "/api/tenants/{tenantId}/billing/attempts/{attemptId}",
    method: "get",
    operationId: "tenantGetBillingAttempt",
    tag: "Billing",
    summary: "Read payment instructions and state for an attempt",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "billing:read",
    parameters: [TENANT_HANDLE_PATH_PARAM, ATTEMPT_ID_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "CheckoutInstruction",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/billing/attempts/{attemptId}/recheck",
    method: "post",
    operationId: "tenantRecheckBillingAttempt",
    tag: "Billing",
    summary: "Trigger a rate-limited AutoLaris Advice settlement check",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "billing:recheck",
    parameters: [TENANT_HANDLE_PATH_PARAM, ATTEMPT_ID_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "BillingRecheckResponse",
    errorStatuses: [401, 403, 404, 409, 429, 503],
    rateLimited: true,
  },
  {
    path: "/api/tenants/{tenantId}/billing/receipts",
    method: "get",
    operationId: "tenantListBillingReceipts",
    tag: "Billing",
    summary: "List immutable numbered PDF receipts for the tenant",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "billing:receipts",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "ReceiptListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
];

export const BILLING_DOMAIN_MODULE: DomainSchemaModule = {
  schemas: {
    BillingPlan: BillingPlanSchema,
    PaymentChannelKind: PaymentChannelKindSchema,
    BillingObligationState: BillingObligationStateSchema,
    PaymentAttemptState: PaymentAttemptStateSchema,
    PaymentChannelOption: PaymentChannelOptionSchema,
    PaymentChannelListResponse: PaymentChannelListResponseSchema,
    CouponApplyRequest: CouponApplyRequestSchema,
    CouponPreviewResponse: CouponPreviewResponseSchema,
    CheckoutAttemptCreateRequest: CheckoutAttemptCreateRequestSchema,
    CheckoutInstruction: CheckoutInstructionSchema,
    BillingObligationSummary: BillingObligationSummarySchema,
    BillingSummaryResponse: BillingSummaryResponseSchema,
    BillingRecheckResponse: BillingRecheckResponseSchema,
    ReceiptSummary: ReceiptSummarySchema,
    ReceiptListResponse: ReceiptListResponseSchema,
  },
  routes: BILLING_ROUTES,
};
