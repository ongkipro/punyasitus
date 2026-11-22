/// <reference types="astro/client" />

import type {
  AuthorizedTenantMember,
  VerifiedPlatformOperatorContext,
} from "@punyasitus/auth";
import type { SurfaceKind } from "@punyasitus/core";
import type { TenantContext } from "../core/tenant.ts";

export interface AuthLocalsUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

export interface AuthLocalsSession {
  readonly id: string;
  readonly userId: string;
  readonly activeOrganizationId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

declare global {
  namespace App {
    interface Locals {
      surface: SurfaceKind;
      host: string;
      isLocalLoopback: boolean;
      tenant: TenantContext | null;
      tenantDb: D1Database | null;
      authUser: AuthLocalsUser | null;
      authSession: AuthLocalsSession | null;
      authorizedTenantMember: AuthorizedTenantMember | null;
      platformOperator: VerifiedPlatformOperatorContext | null;
      twoFactorVerifiedAtMs: number | null;
    }
  }
}

export {};
