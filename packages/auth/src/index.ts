import { createSqliteDrizzle } from "@punyasitus/db/connections";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

export interface CreateAuthOptions {
  readonly baseURL: string;
  readonly secret: string;
  readonly trustedOrigins?: string[];
  readonly schema?: Record<string, unknown>;
}

/**
 * Per-request Better Auth factory over Cloudflare D1 (`PLATFORM_DB`).
 * Never cache a Better Auth instance at module scope in Cloudflare Workers
 * (cross-request I/O is forbidden; PLAN §4).
 */
export function createAuth(platformDb: D1Database, options: CreateAuthOptions) {
  const db = createSqliteDrizzle(platformDb, options.schema);
  return betterAuth({
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: options.trustedOrigins ?? [options.baseURL],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      ...(options.schema ? { schema: options.schema } : {}),
    }),
    advanced: {
      database: {
        joins: true,
      },
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
  });
}
