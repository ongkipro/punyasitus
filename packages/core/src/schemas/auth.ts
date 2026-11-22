import { z } from "zod";
import {
  createPaginatedResponseSchema,
  EmailSchema,
  IDEMPOTENCY_HEADER_PARAM,
  IsoDatetimeSchema,
  RoleSchema,
  TENANT_HANDLE_PATH_PARAM,
  TenantHandleSchema,
  TenantMemberRoleSchema,
  UlidSchema,
  VersionSchema,
  type DomainSchemaModule,
  type RouteContract,
} from "./common.ts";

/**
 * Auth, account security (reauth/TOTP), and tenant member/invitation schemas (PLAN §4, §11.2, §13).
 * Note: Better Auth owns low-level OAuth/session primitives; these schemas define PunyaSitus's
 * application-owned JSON endpoints and guarded membership wrappers.
 */

export const PasswordSchema = z
  .string()
  .min(12)
  .max(128)
  .meta({ description: "Account password (12-128 characters)." });

export const TotpCodeSchema = z
  .string()
  .regex(/^[0-9]{6}$/, "TOTP code must be a 6-digit numeric code")
  .meta({ description: "6-digit TOTP authenticator code." });

export const LoginRequestSchema = z
  .object({
    email: EmailSchema,
    password: z.string().min(1).max(128),
    turnstileToken: z.string().min(1).max(2048),
  })
  .strict()
  .meta({ description: "Email/password fallback login payload (Google OAuth is primary; PLAN §4)." });

export const LoginResponseSchema = z
  .object({
    requiresTwoFactor: z.boolean(),
    redirectTo: z.string().startsWith("/").max(256),
  })
  .strict()
  .meta({ description: "Neutral login response avoiding account enumeration." });

export const ResetPasswordRequestSchema = z
  .object({
    email: EmailSchema,
    turnstileToken: z.string().min(1).max(2048),
  })
  .strict()
  .meta({ description: "Request a single-use expiring password reset link." });

export const ResetPasswordConfirmSchema = z
  .object({
    token: z.string().min(16).max(256),
    newPassword: PasswordSchema,
  })
  .strict()
  .meta({ description: "Confirm single-use password reset token with a new password." });

export const SessionAccountProfileSchema = z
  .object({
    userId: UlidSchema,
    email: EmailSchema,
    displayName: z.string().min(1).max(120),
    emailVerified: z.boolean(),
    totpEnabled: z.boolean(),
    roles: z.array(RoleSchema),
    updatedAt: IsoDatetimeSchema,
  })
  .strict()
  .meta({ description: "Authenticated user's own private account profile." });

export const AccountUpdateRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    email: EmailSchema.optional(),
    reauthToken: z.string().min(16).max(256).optional(),
  })
  .strict()
  .refine((val) => val.displayName !== undefined || val.email !== undefined, {
    message: "At least one account field must be provided",
  })
  .meta({ description: "Self-service update for the currently authenticated user account." });

export const ReauthRequestSchema = z
  .object({
    method: z.enum(["password", "totp", "google_reverify"]),
    password: z.string().min(1).max(128).optional(),
    totpCode: TotpCodeSchema.optional(),
    googleIdToken: z.string().min(16).max(4096).optional(),
  })
  .strict()
  .refine(
    (val) =>
      (val.method === "password" && val.password !== undefined) ||
      (val.method === "totp" && val.totpCode !== undefined) ||
      (val.method === "google_reverify" && val.googleIdToken !== undefined),
    { message: "Credential matching the selected reauthentication method is required" },
  )
  .meta({
    description:
      "Recent reauthentication request required for owner transfer and sensitive console actions (PLAN §4 & §13).",
  });

export const ReauthResponseSchema = z
  .object({
    reauthenticatedAt: IsoDatetimeSchema,
    expiresAt: IsoDatetimeSchema,
  })
  .strict()
  .meta({ description: "Confirmation of a fresh reauthentication window (10 minutes)." });

export const TotpSetupResponseSchema = z
  .object({
    otpauthUri: z.string().startsWith("otpauth://totp/").max(1024),
    backupCodesRemaining: z.number().int().min(0).max(20),
  })
  .strict()
  .meta({ description: "TOTP enrollment URI returned during 2FA setup." });

export const TotpVerifyRequestSchema = z
  .object({
    code: TotpCodeSchema.optional(),
    backupCode: z
      .string()
      .regex(/^[A-Za-z0-9-]{8,32}$/)
      .optional(),
  })
  .strict()
  .refine((val) => (val.code !== undefined) !== (val.backupCode !== undefined), {
    message: "Provide either a 6-digit TOTP code or one single-use backup code",
  })
  .meta({ description: "Verify TOTP enrollment or step-up challenge." });

export const TotpDisableRequestSchema = z
  .object({
    code: TotpCodeSchema,
    reauthToken: z.string().min(16).max(256),
  })
  .strict()
  .meta({ description: "Disable optional tenant-user 2FA (blocked for operators and agency admins)." });

export const TenantMemberSummarySchema = z
  .object({
    memberId: UlidSchema,
    userId: UlidSchema,
    email: EmailSchema,
    displayName: z.string().min(1).max(120),
    role: TenantMemberRoleSchema,
    joinedAt: IsoDatetimeSchema,
    version: VersionSchema,
  })
  .strict()
  .meta({ description: "Tenant organization member summary (5-member cap per tenant; PLAN §4)." });

export const TenantMemberListResponseSchema = createPaginatedResponseSchema(
  TenantMemberSummarySchema,
  "Paginated list of members in the scoped tenant.",
);

export const MemberInviteRequestSchema = z
  .object({
    email: EmailSchema,
    role: z.enum(["admin", "editor"]),
  })
  .strict()
  .meta({
    description:
      "Invite a new admin or editor to the scoped tenant (5-seat cap including pending invites; rejects tenantId).",
  });

export const MemberInviteResponseSchema = z
  .object({
    invitationId: UlidSchema,
    email: EmailSchema,
    role: z.enum(["admin", "editor"]),
    expiresAt: IsoDatetimeSchema,
    status: z.enum(["pending", "accepted", "revoked", "expired"]),
  })
  .strict()
  .meta({ description: "Created single-use expiring tenant member invitation." });

export const MemberInviteAcceptRequestSchema = z
  .object({
    token: z.string().min(16).max(256),
  })
  .strict()
  .meta({ description: "Accept a single-use expiring invitation bound to the invited identity." });

export const MemberRoleUpdateRequestSchema = z
  .object({
    role: z.enum(["admin", "editor"]),
    version: VersionSchema,
  })
  .strict()
  .meta({ description: "Change an existing non-owner member role (owner only)." });

export const OwnerTransferRequestSchema = z
  .object({
    targetMemberId: UlidSchema,
    reauthToken: z.string().min(16).max(256),
    confirmTenantHandle: TenantHandleSchema,
  })
  .strict()
  .meta({
    description:
      "Atomic tenant ownership transfer requiring recent reauthentication (PLAN §4).",
  });

export const ActionAcceptedResponseSchema = z
  .object({
    ok: z.literal(true),
  })
  .strict()
  .meta({ description: "Generic acknowledgement for neutral auth actions." });

const MEMBER_ID_PATH_PARAM = {
  name: "memberId",
  in: "path" as const,
  required: true,
  description: "Tenant membership ULID identifier.",
  schema: UlidSchema,
};

export const AUTH_ROUTES: readonly RouteContract[] = [
  {
    path: "/api/auth/login",
    method: "post",
    operationId: "authLogin",
    tag: "Auth",
    summary: "Sign in with email and password fallback",
    surface: "app",
    auth: "app_session",
    requiredRoles: [],
    requestBodySchemaId: "LoginRequest",
    successStatus: 200,
    successSchemaId: "LoginResponse",
    errorStatuses: [400, 401, 415, 422, 429, 503],
    rateLimited: true,
  },
  {
    path: "/api/auth/reset-password",
    method: "post",
    operationId: "authRequestPasswordReset",
    tag: "Auth",
    summary: "Request a single-use password reset link",
    surface: "app",
    auth: "app_session",
    requiredRoles: [],
    requestBodySchemaId: "ResetPasswordRequest",
    successStatus: 200,
    successSchemaId: "ActionAcceptedResponse",
    errorStatuses: [400, 415, 422, 429, 503],
    rateLimited: true,
  },
  {
    path: "/api/auth/reset-password/confirm",
    method: "post",
    operationId: "authConfirmPasswordReset",
    tag: "Auth",
    summary: "Confirm password reset with single-use expiring token",
    surface: "app",
    auth: "app_session",
    requiredRoles: [],
    requestBodySchemaId: "ResetPasswordConfirm",
    successStatus: 200,
    successSchemaId: "ActionAcceptedResponse",
    errorStatuses: [400, 415, 422, 429, 503],
    rateLimited: true,
  },
  {
    path: "/api/account",
    method: "get",
    operationId: "accountGetProfile",
    tag: "Auth",
    summary: "Read currently authenticated user profile",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin", "platform_operator"],
    successStatus: 200,
    successSchemaId: "SessionAccountProfile",
    errorStatuses: [401, 503],
  },
  {
    path: "/api/account",
    method: "patch",
    operationId: "accountUpdateProfile",
    tag: "Auth",
    summary: "Update current user private profile",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin", "platform_operator"],
    requestBodySchemaId: "AccountUpdateRequest",
    successStatus: 200,
    successSchemaId: "SessionAccountProfile",
    errorStatuses: [400, 401, 403, 415, 422, 503],
  },
  {
    path: "/api/account/reauth",
    method: "post",
    operationId: "accountReauthenticate",
    tag: "Auth",
    summary: "Verify credentials for sensitive actions (10-minute window)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin", "platform_operator"],
    requestBodySchemaId: "ReauthRequest",
    successStatus: 200,
    successSchemaId: "ReauthResponse",
    errorStatuses: [400, 401, 403, 415, 422, 429, 503],
    rateLimited: true,
  },
  {
    path: "/api/account/totp/setup",
    method: "post",
    operationId: "accountSetupTotp",
    tag: "Auth",
    summary: "Begin TOTP 2FA enrollment",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin", "platform_operator"],
    successStatus: 200,
    successSchemaId: "TotpSetupResponse",
    errorStatuses: [401, 409, 503],
  },
  {
    path: "/api/account/totp/verify",
    method: "post",
    operationId: "accountVerifyTotp",
    tag: "Auth",
    summary: "Verify TOTP code or backup code",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin", "platform_operator"],
    requestBodySchemaId: "TotpVerifyRequest",
    successStatus: 200,
    successSchemaId: "ActionAcceptedResponse",
    errorStatuses: [400, 401, 403, 415, 422, 429, 503],
    rateLimited: true,
  },
  {
    path: "/api/account/totp/disable",
    method: "post",
    operationId: "accountDisableTotp",
    tag: "Auth",
    summary: "Disable optional TOTP for non-privileged tenant accounts",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor"],
    requestBodySchemaId: "TotpDisableRequest",
    successStatus: 200,
    successSchemaId: "ActionAcceptedResponse",
    errorStatuses: [400, 401, 403, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/members",
    method: "get",
    operationId: "tenantListMembers",
    tag: "Auth",
    summary: "List members for a tenant",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "agency_admin"],
    requiredPermission: "member:read",
    parameters: [TENANT_HANDLE_PATH_PARAM],
    successStatus: 200,
    successSchemaId: "TenantMemberListResponse",
    errorStatuses: [401, 403, 404, 503],
  },
  {
    path: "/api/tenants/{tenantId}/members/invitations",
    method: "post",
    operationId: "tenantInviteMember",
    tag: "Auth",
    summary: "Invite a member (owner only, 5-member cap)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "member:invite",
    parameters: [TENANT_HANDLE_PATH_PARAM, IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "MemberInviteRequest",
    successStatus: 201,
    successSchemaId: "MemberInviteResponse",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 429, 503],
    rateLimited: true,
    idempotent: true,
  },
  {
    path: "/api/auth/invitations/accept",
    method: "post",
    operationId: "authAcceptInvitation",
    tag: "Auth",
    summary: "Accept a single-use expiring tenant invitation",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "admin", "editor", "agency_admin"],
    requestBodySchemaId: "MemberInviteAcceptRequest",
    successStatus: 200,
    successSchemaId: "ActionAcceptedResponse",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/members/{memberId}",
    method: "patch",
    operationId: "tenantUpdateMemberRole",
    tag: "Auth",
    summary: "Update a member role (owner only)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "member:update_role",
    parameters: [TENANT_HANDLE_PATH_PARAM, MEMBER_ID_PATH_PARAM],
    requestBodySchemaId: "MemberRoleUpdateRequest",
    successStatus: 200,
    successSchemaId: "TenantMemberSummary",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
  },
  {
    path: "/api/tenants/{tenantId}/members/{memberId}",
    method: "delete",
    operationId: "tenantRemoveMember",
    tag: "Auth",
    summary: "Remove a member from a tenant (owner only, cannot remove final owner)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner", "agency_admin"],
    requiredPermission: "member:remove",
    parameters: [TENANT_HANDLE_PATH_PARAM, MEMBER_ID_PATH_PARAM],
    successStatus: 204,
    errorStatuses: [401, 403, 404, 409, 503],
  },
  {
    path: "/api/tenants/{tenantId}/members/transfer-owner",
    method: "post",
    operationId: "tenantTransferOwner",
    tag: "Auth",
    summary: "Atomically transfer tenant ownership (owner + reauth required)",
    surface: "app",
    auth: "app_session",
    requiredRoles: ["owner"],
    requiredPermission: "tenant:transfer_owner",
    parameters: [TENANT_HANDLE_PATH_PARAM, IDEMPOTENCY_HEADER_PARAM],
    requestBodySchemaId: "OwnerTransferRequest",
    successStatus: 200,
    successSchemaId: "ActionAcceptedResponse",
    errorStatuses: [400, 401, 403, 404, 409, 415, 422, 503],
    idempotent: true,
  },
];

export const AUTH_DOMAIN_MODULE: DomainSchemaModule = {
  schemas: {
    LoginRequest: LoginRequestSchema,
    LoginResponse: LoginResponseSchema,
    ResetPasswordRequest: ResetPasswordRequestSchema,
    ResetPasswordConfirm: ResetPasswordConfirmSchema,
    SessionAccountProfile: SessionAccountProfileSchema,
    AccountUpdateRequest: AccountUpdateRequestSchema,
    ReauthRequest: ReauthRequestSchema,
    ReauthResponse: ReauthResponseSchema,
    TotpSetupResponse: TotpSetupResponseSchema,
    TotpVerifyRequest: TotpVerifyRequestSchema,
    TotpDisableRequest: TotpDisableRequestSchema,
    TenantMemberSummary: TenantMemberSummarySchema,
    TenantMemberListResponse: TenantMemberListResponseSchema,
    MemberInviteRequest: MemberInviteRequestSchema,
    MemberInviteResponse: MemberInviteResponseSchema,
    MemberInviteAcceptRequest: MemberInviteAcceptRequestSchema,
    MemberRoleUpdateRequest: MemberRoleUpdateRequestSchema,
    OwnerTransferRequest: OwnerTransferRequestSchema,
    ActionAcceptedResponse: ActionAcceptedResponseSchema,
  },
  routes: AUTH_ROUTES,
};
