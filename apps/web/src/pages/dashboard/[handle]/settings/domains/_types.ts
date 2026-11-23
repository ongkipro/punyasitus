import type {
  ConnectStepInstruction,
  DcvTokenAgeAssessment,
  DomainConnectMode,
  DomainRemedy,
  DomainSslMethod,
  DomainValidationInstructionRecord,
  PostActivationCleanupGuidance,
} from "@punyasitus/core/domains/index";

export type IndependentDomainCheckStatus = "active" | "pending" | "error";

export interface DomainInstructionsDto {
  readonly mode: DomainConnectMode;
  readonly sslMethod: DomainSslMethod;
  readonly cnameTarget: string;
  readonly createBeforeCnameSatisfied: boolean;
  readonly cnameCutoverLocked: boolean;
  readonly readyForCutover: boolean;
  readonly awaitingProviderTokens: boolean;
  readonly steps: readonly ConnectStepInstruction[];
  readonly noticesId: readonly string[];
}

export interface TenantDomainItemDto {
  readonly id: number;
  readonly hostname: string;
  readonly kind: "subdomain" | "custom";
  readonly mode: DomainConnectMode | null;
  readonly sslMethod: DomainSslMethod | null;
  readonly cfCustomHostnameId: string | null;
  readonly status: string;
  readonly hostStatus: string;
  readonly sslStatus: string;
  readonly ownershipStatus: IndependentDomainCheckStatus;
  readonly tlsStatus: IndependentDomainCheckStatus;
  readonly providerStatus: string | null;
  readonly providerSslStatus: string | null;
  readonly certificateAuthority: string | null;
  readonly dnsTargetObserved: string | null;
  readonly httpsProbePassed: boolean;
  readonly isPrimary: boolean;
  readonly isLocked: boolean;
  readonly failureCode: string | null;
  readonly lastCheckedAt: string | null;
  readonly tokenIssuedAt: string | null;
  readonly tokenExpiresAt: string | null;
  readonly tokenAge: DcvTokenAgeAssessment | null;
  readonly validationRecords: readonly DomainValidationInstructionRecord[];
  readonly cloudflareNameserverHint: boolean;
  readonly postActivationCleanup: PostActivationCleanupGuidance | null;
  readonly instructions: DomainInstructionsDto | null;
  readonly remedies: readonly DomainRemedy[];
  readonly version: number;
}

export interface PlatformSupportContactDto {
  readonly salesWhatsappHref: string | null;
  readonly salesWhatsappDisplay: string | null;
  readonly supportEmail: string;
}

export interface DomainsManagerProps {
  readonly tenantId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly tenantStatus: string;
  readonly currentRole: string;
  readonly canReadDomains: boolean;
  readonly canManageDomains: boolean;
  readonly cnameTarget: string;
  readonly saasZone: string;
  readonly apiBaseUrl: string;
  readonly billingHref: string;
  readonly supportContact: PlatformSupportContactDto;
  readonly initialItems: readonly TenantDomainItemDto[];
  readonly initialCustomDomainLocked: boolean;
  readonly maxCustomHostnames: number;
}
