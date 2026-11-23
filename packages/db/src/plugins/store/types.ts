import type {
  PluginAddonOrderStatus,
  PluginBillingModel,
  PluginCustomDevRequestStatus,
  PluginEntitlementSourceKind,
  PluginEntitlementStatus,
  PluginPayerKind,
  PluginPrivateGrantStatus,
  PluginVisibilityTier,
} from "@punyasitus/core/plugins/billing";

export interface PluginStoreErrorField {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export class PluginStoreError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
  readonly code: string;
  readonly reasonCode: string;
  readonly fields?: readonly PluginStoreErrorField[];

  constructor(
    status: PluginStoreError["status"],
    code: string,
    message: string,
    options?: {
      readonly reasonCode?: string;
      readonly fields?: readonly PluginStoreErrorField[];
      readonly cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PluginStoreError";
    this.status = status;
    this.code = code;
    this.reasonCode = options?.reasonCode ?? code;
    this.fields = options?.fields;
  }
}

export interface PluginCatalogItemRecord {
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly visibilityTier: PluginVisibilityTier;
  readonly billingModel: PluginBillingModel;
  readonly priceIdr: number;
  readonly active: boolean;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface PluginPrivateGrantRecord {
  readonly id: string;
  readonly pluginSlug: string;
  readonly tenantId: string | null;
  readonly agencyId: string | null;
  readonly status: PluginPrivateGrantStatus;
  readonly grantedByUserId: string;
  readonly grantReason: string;
  readonly revokedAtMs: number | null;
  readonly revokedAtIso: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface PluginTenantEntitlementRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly pluginSlug: string;
  readonly sourceKind: PluginEntitlementSourceKind;
  readonly payerKind: PluginPayerKind;
  readonly payerAgencyId: string | null;
  readonly status: PluginEntitlementStatus;
  readonly enabled: boolean;
  readonly expiresAtMs: number | null;
  readonly expiresAtIso: string | null;
  readonly lastPaymentAttemptId: string | null;
  readonly lastReceiptId: string | null;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface PluginAddonOrderRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly pluginSlug: string;
  readonly billingModel: Exclude<PluginBillingModel, "free">;
  readonly payerKind: PluginPayerKind;
  readonly payerAgencyId: string | null;
  readonly payerUserId: string;
  readonly channelCode: string;
  readonly grossAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly couponCode: string | null;
  readonly channelFeeIdr: number;
  readonly netAmountIdr: number;
  readonly totalPayableIdr: number;
  readonly providerAccountId: string;
  readonly providerReffId: string;
  readonly paymentAttemptId: string;
  readonly receiptId: string | null;
  readonly status: PluginAddonOrderStatus;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly paymentInstructions: Record<string, unknown> | null;
  readonly expiresAtMs: number;
  readonly expiresAtIso: string;
  readonly version: number;
  readonly createdAtMs: number;
  readonly createdAtIso: string;
  readonly settledAtMs: number | null;
  readonly settledAtIso: string | null;
  readonly updatedAtMs: number;
  readonly updatedAtIso: string;
}

export interface PluginAddonReceiptRecord {
  readonly id: string;
  readonly receiptNumber: string;
  readonly tenantId: string;
  readonly payerKind: PluginPayerKind;
  readonly payerAgencyId: string | null;
  readonly payerUserId: string;
  readonly tenantNameSnapshot: string;
  readonly payerNameSnapshot: string;
  readonly pluginSlug: string;
  readonly pluginNameSnapshot: string;
  readonly billingModel: Exclude<PluginBillingModel, "free">;
  readonly orderId: string;
  readonly entitlementId: string;
  readonly currency: "IDR";
  readonly grossAmountIdr: number;
  readonly discountAmountIdr: number;
  readonly channelFeeIdr: number;
  readonly totalAmountIdr: number;
  readonly couponCode: string | null;
  readonly paymentChannel: string;
  readonly providerReference: string | null;
  readonly r2ObjectKey: string;
  readonly pdfSha256: string;
  readonly pdfByteLength: number;
  readonly nonPkpNotice: string;
  readonly issuedAtMs: number;
  readonly issuedAtIso: string;
  readonly createdAtMs: number;
  readonly createdAtIso: string;
}

export interface PluginCustomDevRequestRecord {
  readonly id: string;
  readonly requestCode: string;
  readonly tenantId: string;
  readonly tenantHandle: string | null;
  readonly tenantName: string | null;
  readonly requestedByUserId: string;
  readonly serviceKind: "custom_plugin";
  readonly title: string;
  readonly requirementsSummary: string;
  readonly contactWhatsapp: string;
  readonly budgetRange: string | null;
  readonly status: PluginCustomDevRequestStatus;
  readonly quoteAmountIdr: number | null;
  readonly operatorNotes: string | null;
  readonly statusReason: string | null;
  readonly linkedGrantId: string | null;
  readonly linkedPluginSlug: string | null;
  readonly idempotencyKey: string | null;
  readonly dayBucket: string;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
}

export interface TenantPluginStoreItemView {
  readonly slug: string;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly visibilityTier: PluginVisibilityTier;
  readonly billingModel: PluginBillingModel;
  readonly priceIdr: number;
  readonly entitled: boolean;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly entitlementStatus: PluginEntitlementStatus | null;
  readonly sourceKind: PluginEntitlementSourceKind | null;
  readonly expiresAtIso: string | null;
  readonly canInstall: boolean;
  readonly canTenantCheckout: boolean;
  readonly agencyManagedBilling: boolean;
  readonly checkoutBlockCode: "AGENCY_PAYER_ONLY" | null;
  readonly activeGrantId: string | null;
  readonly activeGrantScope: "tenant" | "agency" | null;
}

export interface TenantPluginStoreSnapshot {
  readonly tenantId: string;
  readonly owningAgencyId: string | null;
  readonly billingPayer: PluginPayerKind;
  readonly items: readonly TenantPluginStoreItemView[];
  readonly orders: readonly PluginAddonOrderRecord[];
  readonly receipts: readonly PluginAddonReceiptRecord[];
  readonly customDevRequests: readonly PluginCustomDevRequestRecord[];
  readonly customDevQuota: {
    readonly used: number;
    readonly limit: number;
    readonly remaining: number;
    readonly dayBucket: string;
  };
}
