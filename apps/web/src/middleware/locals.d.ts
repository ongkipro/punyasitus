/// <reference types="astro/client" />

import type { SurfaceKind } from "@punyasitus/core";
import type { TenantContext } from "../core/tenant.ts";

declare global {
  namespace App {
    interface Locals {
      surface: SurfaceKind;
      host: string;
      isLocalLoopback: boolean;
      tenant: TenantContext | null;
      tenantDb: D1Database | null;
    }
  }
}

export {};
