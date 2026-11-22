import {
  ALLOWED_EMAIL_SENDER,
  DEFAULT_EMAIL_SENDER_NAME,
  renderEmailTemplate,
  type EmailPort,
} from "@punyasitus/core/email/index";
import { createSqliteDrizzle } from "@punyasitus/db/connections";
import {
  accounts,
  invitations,
  members,
  organizations,
  sessions,
  users,
  verifications,
} from "@punyasitus/db/platform";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAccessControl } from "better-auth/plugins/access";
import { organization } from "better-auth/plugins/organization";
import { defaultStatements } from "better-auth/plugins/organization/access";
import { relations } from "drizzle-orm";
import { getAuthCookieConfig, type AuthSurface } from "./cookies.ts";

/**
 * Canonical Better Auth -> Drizzle SQLite (`PLATFORM_DB`) schema mapping.
 * Maps Better Auth singular model keys to the plural SQLite tables declared in
 * `packages/db/src/platform/schema.ts` and `0001_initial_platform.sql`.
 */
export const BETTER_AUTH_SCHEMA_MAPPING = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  organization: organizations,
  member: members,
  invitation: invitations,
} as const;

const userRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  members: many(members),
  invitations: many(invitations),
}));

const sessionRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

const accountRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

const organizationRelations = relations(organizations, ({ many }) => ({
  members: many(members),
  invitations: many(invitations),
}));

const memberRelations = relations(members, ({ one }) => ({
  organization: one(organizations, {
    fields: [members.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [members.userId],
    references: [users.id],
  }),
}));

const invitationRelations = relations(invitations, ({ one }) => ({
  organization: one(organizations, {
    fields: [invitations.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [invitations.inviterId],
    references: [users.id],
  }),
}));

/**
 * Complete Drizzle schema including relational definitions required by Better Auth
 * when `advanced.database.joins: true` is enabled.
 */
export const BETTER_AUTH_DRIZZLE_SCHEMA = {
  ...BETTER_AUTH_SCHEMA_MAPPING,
  userRelations,
  sessionRelations,
  accountRelations,
  organizationRelations,
  memberRelations,
  invitationRelations,
} as const;

export const ORGANIZATION_MEMBERSHIP_LIMIT = 5 as const;
export const ORGANIZATION_INVITATION_EXPIRES_IN_SECONDS = 60 * 60 * 48; // 48h (PLAN §10)
export const RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS = 60 * 30; // 30m
export const DEFAULT_SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7; // 7d
export const DEFAULT_SESSION_FRESH_AGE_SECONDS = 60 * 10; // 10m

/**
 * Better Auth Organization plugin access control aligned with PLAN §4 and the
 * SQLite `CHECK (role IN ('owner', 'admin', 'editor', 'agency_staff', 'setup_staff'))` constraint.
 */
export const organizationAc = createAccessControl(defaultStatements);

export const organizationRoles = {
  owner: organizationAc.newRole({
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
  }),
  admin: organizationAc.newRole({
    organization: ["update"],
    member: [],
    invitation: [],
  }),
  editor: organizationAc.newRole({
    organization: [],
    member: [],
    invitation: [],
  }),
  agency_staff: organizationAc.newRole({
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
  }),
  setup_staff: organizationAc.newRole({
    organization: [],
    member: [],
    invitation: [],
  }),
};

export interface CreateAuthOptions {
  readonly baseURL: string;
  readonly secret: string;
  /** Platform surface owning this auth instance (`app` default; `console` uses distinct cookie boundary). */
  readonly surface?: AuthSurface;
  readonly trustedOrigins?: string[];
  readonly schema?: Record<string, unknown>;
  /** Optional EmailPort (`createCloudflareEmailAdapter`, `createResendFallbackAdapter`, or `createLocalMailSink`). */
  readonly emailPort?: EmailPort | null;
  readonly resetPasswordTokenExpiresIn?: number;
  readonly sessionExpiresIn?: number;
  readonly sessionFreshAge?: number;
  readonly onSendResetPassword?: (data: {
    readonly user: { readonly id: string; readonly email: string; readonly name: string };
    readonly url: string;
    readonly token: string;
  }) => Promise<void> | void;
}

/**
 * Per-request Better Auth factory over Cloudflare D1 (`PLATFORM_DB`).
 *
 * Security & runtime invariants (PLAN §4; REQ-034):
 * - Instantiated per request (never cached at module scope in Cloudflare Workers).
 * - Drizzle SQLite adapter with `advanced.database.joins: true` and `ipAddressHeaders: ["cf-connecting-ip"]`.
 * - Host-only `__Host-` session cookies (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, NO `Domain`).
 * - `organization({ membershipLimit: 5 })` enforcing canonical PunyaSitus roles and `updatedAt` parity.
 * - Password reset revokes existing sessions (`revokeSessionsOnPasswordReset: true`) and dispatches
 *   single-use expiring links through `EmailPort` without logging secrets or tokens.
 */
export function createAuth(platformDb: D1Database, options: CreateAuthOptions) {
  const resolvedSchema: Record<string, unknown> = options.schema ?? {
    ...BETTER_AUTH_DRIZZLE_SCHEMA,
  };
  const db = createSqliteDrizzle(platformDb, resolvedSchema);
  const surface: AuthSurface = options.surface ?? "app";
  const cookieConfig = getAuthCookieConfig(surface);
  const resetExpiresIn =
    options.resetPasswordTokenExpiresIn ?? RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS;
  const sessionExpiresIn = options.sessionExpiresIn ?? DEFAULT_SESSION_EXPIRES_IN_SECONDS;
  const sessionFreshAge = options.sessionFreshAge ?? DEFAULT_SESSION_FRESH_AGE_SECONDS;
  const normalizedBaseUrl = options.baseURL.replace(/\/+$/, "");

  return betterAuth({
    baseURL: normalizedBaseUrl,
    secret: options.secret,
    trustedOrigins: options.trustedOrigins ?? [normalizedBaseUrl],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: resolvedSchema,
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: resetExpiresIn,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url, token }) => {
        if (options.emailPort) {
          const resetPageUrl = `${normalizedBaseUrl}/auth/reset-password?token=${encodeURIComponent(token)}`;
          const rendered = renderEmailTemplate("reset-password", {
            recipientName: user.name,
            resetUrl: resetPageUrl,
            expiresInMinutes: Math.max(1, Math.round(resetExpiresIn / 60)),
          });
          await options.emailPort.send({
            messageKey: `reset-password:${user.id}:${token.slice(0, 12)}`,
            template: "reset-password",
            from: ALLOWED_EMAIL_SENDER,
            fromName: DEFAULT_EMAIL_SENDER_NAME,
            to: user.email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            oneShot: true,
          });
        }
        if (options.onSendResetPassword) {
          await options.onSendResetPassword({
            user: { id: user.id, email: user.email, name: user.name },
            url,
            token,
          });
        }
      },
    },
    emailVerification: options.emailPort
      ? {
          sendVerificationEmail: async ({ user, url, token }) => {
            if (!options.emailPort) return;
            const rendered = renderEmailTemplate("verify-email", {
              recipientName: user.name,
              verifyUrl: url,
              expiresInMinutes: 30,
            });
            await options.emailPort.send({
              messageKey: `verify-email:${user.id}:${token.slice(0, 12)}`,
              template: "verify-email",
              from: ALLOWED_EMAIL_SENDER,
              fromName: DEFAULT_EMAIL_SENDER_NAME,
              to: user.email,
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
              oneShot: true,
            });
          },
        }
      : undefined,
    user: {
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: false,
      },
    },
    session: {
      expiresIn: sessionExpiresIn,
      updateAge: 60 * 60 * 24,
      freshAge: sessionFreshAge,
      storeSessionInDatabase: true,
    },
    plugins: [
      organization({
        ac: organizationAc,
        roles: organizationRoles,
        creatorRole: "owner",
        membershipLimit: ORGANIZATION_MEMBERSHIP_LIMIT,
        invitationExpiresIn: ORGANIZATION_INVITATION_EXPIRES_IN_SECONDS,
        schema: {
          organization: {
            additionalFields: {
              updatedAt: {
                type: "date",
                required: false,
                defaultValue: () => new Date(),
                input: false,
              },
            },
          },
        },
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: org }) => ({
            data: {
              ...org,
              updatedAt: new Date(),
            },
          }),
          beforeUpdateOrganization: async ({ organization: org }) => ({
            data: {
              ...org,
              updatedAt: new Date(),
            },
          }),
        },
      }),
    ],
    advanced: {
      database: {
        joins: true,
      },
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
      disableCSRFCheck: false,
      // Keep `useSecureCookies: false` so Better Auth does NOT prepend `__Secure-`
      // ahead of our explicit `__Host-` cookie names; `Secure` is enforced via
      // `defaultCookieAttributes` and per-cookie `attributes` (cookies.ts).
      useSecureCookies: false,
      crossSubDomainCookies: {
        enabled: false,
      },
      cookiePrefix: cookieConfig.cookiePrefix,
      defaultCookieAttributes: cookieConfig.defaultCookieAttributes,
      cookies: cookieConfig.betterAuthAdvancedCookies,
    },
  });
}

export type PunyaSitusAuth = ReturnType<typeof createAuth>;

export * from "./account.ts";
export * from "./cookies.ts";
export * from "./permissions.ts";
export * from "./session-guard.ts";
