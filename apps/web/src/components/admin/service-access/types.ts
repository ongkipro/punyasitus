import type { SuspensionReason } from "@punyasitus/core/billing/index";
import type { LifecycleStatus } from "../navigation";

export interface ServiceAccessContext {
  readonly status: LifecycleStatus;
  readonly operatorHold?: boolean;
  readonly operatorHoldReason?: string | null;
  readonly suspensionReason?: SuspensionReason | null;
  readonly agencyManaged?: boolean;
  /** True for tenant owner (or agency_admin on agency-managed tenants); false for non-payer members. */
  readonly isPayer: boolean;
  readonly canExportLeadsCsv?: boolean;
  readonly daysRemaining?: number | null;
  readonly trialEndsAtLabel?: string | null;
  readonly paidThroughLabel?: string | null;
  readonly graceEndsAtLabel?: string | null;
  readonly lockedEndsAtLabel?: string | null;
  readonly deletionDueAtLabel?: string | null;
  readonly billingHref?: string;
  readonly leadsExportHref?: string;
  readonly signOutHref?: string;
  readonly supportHref?: string;
}
