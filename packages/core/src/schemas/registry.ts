import { z } from "zod";
import { AUTH_DOMAIN_MODULE } from "./auth.ts";
import { BILLING_DOMAIN_MODULE } from "./billing.ts";
import { CMS_DOMAIN_MODULE } from "./cms.ts";
import {
  COMMON_COMPONENT_SCHEMAS,
  RoleSchema,
  SurfaceKindSchema,
  type DomainSchemaModule,
  type RouteContract,
} from "./common.ts";
import { CONSOLE_DOMAIN_MODULE } from "./console.ts";
import { DOMAINS_DOMAIN_MODULE } from "./domains.ts";
import { LEADS_EVENTS_DOMAIN_MODULE } from "./leads-events.ts";
import { PUBLIC_DTO_SCHEMAS } from "./public-dto.ts";

/**
 * Central OpenAPI 3.1 contract assembler.
 * Uses Zod 4's native `z.toJSONSchema()` over a dedicated schema registry —
 * zero external OpenAPI generator dependencies.
 */

const DOMAIN_MODULES: readonly DomainSchemaModule[] = [
  AUTH_DOMAIN_MODULE,
  CMS_DOMAIN_MODULE,
  DOMAINS_DOMAIN_MODULE,
  LEADS_EVENTS_DOMAIN_MODULE,
  BILLING_DOMAIN_MODULE,
  CONSOLE_DOMAIN_MODULE,
];

export const ROUTE_CONTRACTS: readonly RouteContract[] = DOMAIN_MODULES.flatMap(
  (mod) => mod.routes,
);

export const ALL_COMPONENT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  ...COMMON_COMPONENT_SCHEMAS,
  ...PUBLIC_DTO_SCHEMAS,
  ...AUTH_DOMAIN_MODULE.schemas,
  ...CMS_DOMAIN_MODULE.schemas,
  ...DOMAINS_DOMAIN_MODULE.schemas,
  ...LEADS_EVENTS_DOMAIN_MODULE.schemas,
  ...BILLING_DOMAIN_MODULE.schemas,
  ...CONSOLE_DOMAIN_MODULE.schemas,
};

const ERROR_RESPONSE_COMPONENTS: Readonly<Record<number, string>> = {
  400: "BadRequest",
  401: "Unauthorized",
  403: "Forbidden",
  404: "NotFound",
  409: "Conflict",
  413: "PayloadTooLarge",
  415: "UnsupportedMediaType",
  422: "ValidationError",
  429: "RateLimited",
  503: "ServiceUnavailable",
};

function stripJsonSchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "$id") continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function buildComponentsSchemas(): Record<string, Record<string, unknown>> {
  const registry = z.registry<{ id: string }>();
  const sortedNames = Object.keys(ALL_COMPONENT_SCHEMAS).sort();
  for (const name of sortedNames) {
    const schema = ALL_COMPONENT_SCHEMAS[name];
    if (schema) {
      registry.add(schema, { id: name });
    }
  }

  const emitted = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    unrepresentable: "any",
    uri: (id) => `#/components/schemas/${id}`,
  });

  const components: Record<string, Record<string, unknown>> = {};
  for (const name of sortedNames) {
    const raw = emitted.schemas[name];
    if (raw && typeof raw === "object") {
      components[name] = stripJsonSchemaMeta(raw as Record<string, unknown>);
    }
  }
  return components;
}

function inlineParameterSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return stripJsonSchemaMeta(raw);
}

function buildOperationObject(route: RouteContract): Record<string, unknown> {
  const security =
    route.auth === "anonymous_tenant_host" || route.requiredRoles.length === 0
      ? []
      : route.auth === "console_session"
        ? [{ consoleSessionCookie: [] }]
        : [{ appSessionCookie: [] }];

  const responses: Record<string, unknown> = {};
  if (route.successStatus === 204) {
    responses["204"] = { description: "Operation succeeded with no content." };
  } else if (route.successSchemaId) {
    responses[String(route.successStatus)] = {
      description: "Operation succeeded.",
      content: {
        "application/json": {
          schema: { $ref: `#/components/schemas/${route.successSchemaId}` },
        },
      },
    };
  } else {
    responses[String(route.successStatus)] = { description: "Operation succeeded." };
  }

  for (const status of route.errorStatuses) {
    const refName = ERROR_RESPONSE_COMPONENTS[status];
    if (refName) {
      responses[String(status)] = { $ref: `#/components/responses/${refName}` };
    }
  }

  const operation: Record<string, unknown> = {
    operationId: route.operationId,
    tags: [route.tag],
    summary: route.summary,
    security,
    "x-surface": route.surface,
    "x-required-roles": [...route.requiredRoles],
    responses,
  };

  if (route.description) {
    operation["description"] = route.description;
  }
  if (route.requiredPermission) {
    operation["x-required-permission"] = route.requiredPermission;
  }
  if (route.auth === "anonymous_tenant_host") {
    operation["x-origin-policy"] = "tenant-host-only";
  }
  if (route.rateLimited) {
    operation["x-rate-limited"] = true;
  }
  if (route.idempotent) {
    operation["x-idempotent"] = true;
  }

  if (route.parameters && route.parameters.length > 0) {
    operation["parameters"] = route.parameters.map((param) => ({
      name: param.name,
      in: param.in,
      required: param.required,
      description: param.description,
      schema: inlineParameterSchema(param.schema),
    }));
  }

  if (route.requestBodySchemaId) {
    const contentTypes = route.requestBodyContentTypes ?? ["application/json"];
    const content: Record<string, unknown> = {};
    for (const ct of contentTypes) {
      content[ct] = {
        schema: { $ref: `#/components/schemas/${route.requestBodySchemaId}` },
      };
    }
    operation["requestBody"] = {
      required: true,
      content,
    };
  }

  return operation;
}

export interface OpenApiDocument {
  readonly openapi: "3.1.1";
  readonly jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base";
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
  readonly servers: readonly Record<string, unknown>[];
  readonly tags: readonly { readonly name: string; readonly description: string }[];
  readonly "x-punyasitus-roles": readonly string[];
  readonly "x-punyasitus-surfaces": readonly string[];
  readonly paths: Record<string, Record<string, unknown>>;
  readonly components: {
    readonly securitySchemes: Record<string, unknown>;
    readonly headers: Record<string, unknown>;
    readonly responses: Record<string, unknown>;
    readonly schemas: Record<string, Record<string, unknown>>;
  };
}

export function buildOpenApiDocument(): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const seenOperationIds = new Set<string>();

  for (const route of ROUTE_CONTRACTS) {
    if (seenOperationIds.has(route.operationId)) {
      throw new Error(`Duplicate OpenAPI operationId: ${route.operationId}`);
    }
    seenOperationIds.add(route.operationId);

    const existing = paths[route.path] ?? {};
    existing[route.method] = buildOperationObject(route);
    paths[route.path] = existing;
  }

  const standardErrorContent = {
    "application/json": {
      schema: { $ref: "#/components/schemas/ApiError" },
    },
  };

  return {
    openapi: "3.1.1",
    jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    info: {
      title: "PunyaSitus HTTP Contract",
      version: "0.1.0",
      description:
        "Machine-readable OpenAPI 3.1 contract generated from packages/core/src/schemas/*.ts (PLAN §4 & §6, TASK-024). Tenant ID/handle is a selector only, never authorization.",
    },
    servers: [
      {
        url: "https://app.punyasitus.com",
        description: "Tenant, agency, and affiliate application surface",
      },
      {
        url: "https://console.punyasitus.com",
        description: "Superadmin operator console surface",
      },
      {
        url: "https://{tenantHost}",
        description: "Verified tenant public host (*.situsku.click or active custom domain)",
        variables: {
          tenantHost: {
            default: "alpha-studio.situsku.click",
            description: "Verified tenant hostname resolved via PLATFORM_DB",
          },
        },
      },
    ],
    tags: [
      { name: "Auth", description: "Authentication, account security (reauth/TOTP), and membership" },
      { name: "CMS", description: "Tenant pages, posts, typed offerings, taxonomies, menus, media, outlets, settings, themes, preview, and leads" },
      { name: "Domains", description: "Custom domain connect, verification recheck, primary switch, and removal" },
      { name: "Leads & Events", description: "Host-scoped anonymous tenant POST endpoints (/api/leads, /api/events, /api/abuse-report)" },
      { name: "Billing", description: "Owner/agency AutoLaris QRIS/VA subscription billing, coupons, and PDF receipts" },
      { name: "Console", description: "Superadmin platform operations on console.punyasitus.com" },
    ],
    "x-punyasitus-roles": [...RoleSchema.options],
    "x-punyasitus-surfaces": [...SurfaceKindSchema.options],
    paths,
    components: {
      securitySchemes: {
        appSessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-punyasitus_app_session",
          description:
            "Host-only Secure HttpOnly session cookie on app.punyasitus.com; state-changing JSON requests also require exact Origin header.",
        },
        consoleSessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-punyasitus_console_session",
          description:
            "Host-only Secure HttpOnly session cookie on console.punyasitus.com; requires active platform_operators grant and verified TOTP.",
        },
      },
      headers: {
        RetryAfter: {
          description: "Seconds to wait before retrying a rate-limited or unavailable request.",
          schema: { type: "integer", minimum: 1 },
        },
      },
      responses: {
        BadRequest: {
          description: "Malformed JSON syntax or bad request (400).",
          content: standardErrorContent,
        },
        Unauthorized: {
          description: "Unauthenticated request (401).",
          content: standardErrorContent,
        },
        Forbidden: {
          description: "Role, origin policy, TOTP, reauth, or subscription lock denial (403).",
          content: standardErrorContent,
        },
        NotFound: {
          description: "Missing resource, unknown host, or cross-tenant target (404).",
          content: standardErrorContent,
        },
        Conflict: {
          description: "Optimistic concurrency stale version or resource conflict (409).",
          content: standardErrorContent,
        },
        PayloadTooLarge: {
          description: "Request body exceeded configured byte ceiling (413).",
          content: standardErrorContent,
        },
        UnsupportedMediaType: {
          description: "Unsupported Content-Type header (415).",
          content: standardErrorContent,
        },
        ValidationError: {
          description: "Strict schema validation or business rule rejection (422).",
          content: standardErrorContent,
        },
        RateLimited: {
          description: "Rate limit exceeded (429).",
          headers: {
            "Retry-After": { $ref: "#/components/headers/RetryAfter" },
          },
          content: standardErrorContent,
        },
        ServiceUnavailable: {
          description: "Control plane, TenantStore, or upstream provider unavailable (503).",
          headers: {
            "Retry-After": { $ref: "#/components/headers/RetryAfter" },
          },
          content: standardErrorContent,
        },
      },
      schemas: buildComponentsSchemas(),
    },
  };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Deterministic sorted-key JSON output committed at `docs/api/openapi.json`
 * and verified byte-for-byte in CI tests (TASK-024).
 */
export function serializeOpenApiDocument(doc: OpenApiDocument = buildOpenApiDocument()): string {
  return `${JSON.stringify(sortKeysDeep(doc), null, 2)}\n`;
}
