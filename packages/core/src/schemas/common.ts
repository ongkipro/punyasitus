import { z } from "zod";

/**
 * Forbidden cross-tenant selector keys that MUST NEVER be accepted in
 * tenant-scoped or host-scoped write request bodies (PLAN §2, §4, §6).
 * Tenant scope comes exclusively from the verified route handle + membership
 * (admin APIs) or the verified request Host (public tenant APIs).
 */
export const FORBIDDEN_TENANT_SELECTOR_KEYS = [
  "tenantId",
  "tenant_id",
  "organizationId",
  "organization_id",
  "tenantHandle",
  "tenant_handle",
] as const;

export const RESERVED_TENANT_HANDLES = new Set<string>([
  "www",
  "fallback",
  "cname",
  "app",
  "console",
  "admin",
  "api",
  "auth",
  "account",
  "agency",
  "affiliate",
  "dashboard",
  "platform",
  "mcp",
  "mail",
  "notif",
  "assets",
  "blog",
  "layanan",
  "produk",
  "tour",
  "kendaraan",
  "katalog",
]);

export const RESERVED_PUBLIC_SLUGS = new Set<string>([
  "api",
  "blog",
  "layanan",
  "produk",
  "tour",
  "kendaraan",
  "katalog",
  "sitemap.xml",
  "robots.txt",
  "assets",
  "admin",
  "dashboard",
  "agency",
  "affiliate",
  "console",
  "platform",
  "auth",
  "account",
  "mcp",
  "category",
  "tag",
]);

export const UlidSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "Must be a valid 26-character ULID")
  .meta({
    description: "Immutable 26-character Crockford Base32 ULID identifier.",
    examples: ["01JTESTTENANTALPHA00000001"],
  });

export const UuidSchema = z.uuid().meta({
  description: "RFC 4122 UUID string.",
});

export const TenantHandleSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/,
    "Tenant handle must be 3-40 lowercase ASCII characters with alphanumeric ends",
  )
  .refine((val) => !RESERVED_TENANT_HANDLES.has(val), {
    message: "Tenant handle uses a reserved platform label",
  })
  .meta({
    description: "Immutable lowercase tenant handle (3-40 chars) used in admin URLs and *.situsku.click.",
    examples: ["alpha-studio"],
  });

export const SlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/,
    "Slug must be lowercase ASCII alphanumeric segments separated by single hyphens (max 80 chars)",
  )
  .meta({
    description: "SEO-friendly lowercase URL slug (1-80 chars, PLAN §7.1).",
    examples: ["paket-wisata-bali"],
  });

export const SequentialIdSchema = z
  .number()
  .int()
  .min(1)
  .max(2_147_483_647)
  .meta({
    description: "Per-tenant sequential positive integer ID (#42, PLAN §7.1).",
  });

export const VersionSchema = z
  .number()
  .int()
  .min(0)
  .max(2_147_483_647)
  .meta({
    description: "Optimistic concurrency control version integer (PLAN §5).",
  });

export const IdrAmountSchema = z
  .number()
  .int()
  .min(0)
  .max(999_999_999_999)
  .meta({
    description: "Nonnegative whole IDR integer amount (0 to 999,999,999,999; PLAN §5).",
  });

export const IsoDatetimeSchema = z.iso.datetime().meta({
  description: "UTC ISO-8601 timestamp string.",
});

export const IsoDateSchema = z.iso.date().meta({
  description: "Calendar date-only ISO string (YYYY-MM-DD).",
});

export const EmailSchema = z.email().max(254).meta({
  description: "Validated email address (max 254 chars).",
});

export const NormalizedPhoneSchema = z
  .string()
  .regex(/^\+?[0-9]{8,15}$/, "Phone must be a normalized 8-15 digit E.164/Indonesian phone number")
  .meta({
    description: "Normalized phone number in international/E.164 digits without separators.",
    examples: ["6281234567890"],
  });

export const HttpsUrlSchema = z
  .string()
  .max(2048)
  .regex(
    /^https:\/\/[^\s/@]+(?:\/[^\s]*)?$/,
    "Must be a valid HTTPS URL without embedded credentials or whitespace",
  )
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.hostname !== "localhost" &&
        !/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(parsed.hostname)
      );
    } catch {
      return false;
    }
  }, "HTTPS URL must not embed credentials or point to localhost/private IPs")
  .meta({
    description: "Validated public HTTPS URL without embedded credentials or private hosts.",
  });

export const HostnameSchema = z
  .string()
  .min(4)
  .max(64)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
    "Hostname must be a lowercase FQDN up to 64 characters without wildcards, schemes, or ports",
  )
  .refine(
    (host) =>
      host !== "punyasitus.com" &&
      !host.endsWith(".punyasitus.com") &&
      host !== "situsku.click" &&
      !host.endsWith(".situsku.click") &&
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host),
    "Hostname cannot be a platform host, the SaaS zone, or an IP address",
  )
  .meta({
    description: "Normalized custom hostname (<= 64 chars per Cloudflare SSL CN Error 1469; PLAN §3.1).",
    examples: ["www.tokocontoh.id"],
  });

export const IdempotencyKeySchema = UuidSchema.meta({
  description: "Client-generated UUID idempotency key retained across retries of the same attempt.",
});

export const TenantStatusSchema = z
  .enum([
    "provisioning",
    "trial",
    "active",
    "grace",
    "locked",
    "suspended",
    "recovery",
    "purging",
    "purged",
  ])
  .meta({ description: "Authoritative tenant service lifecycle status (PLAN §3 & §17.1)." });

export const SurfaceKindSchema = z
  .enum(["marketing", "app", "console", "tenant"])
  .meta({ description: "Host-isolated runtime surface (PLAN §2)." });

export const RoleSchema = z
  .enum(["owner", "admin", "editor", "platform_operator", "agency_admin"])
  .meta({ description: "Canonical PunyaSitus RBAC role (PLAN §4)." });

export const TenantMemberRoleSchema = z
  .enum(["owner", "admin", "editor"])
  .meta({ description: "Organization-scoped tenant membership role." });

export const OfferingTypeSchema = z
  .enum(["service", "product", "tour", "vehicle"])
  .meta({ description: "Closed offering vertical type (PLAN §5.2)." });

export const PriceModeSchema = z
  .enum(["fixed", "from", "range", "on_request"])
  .meta({ description: "Display price mode for showcase catalog offerings." });

export const OfferingCtaKindSchema = z
  .enum(["whatsapp", "external_link", "inquiry", "book"])
  .meta({ description: "Allowed showcase CTA conversion mode (no cart/checkout)." });

export const VehicleUnitStatusSchema = z
  .enum(["available", "booked", "sold"])
  .meta({ description: "Optional unit status for vehicle offerings." });

export const PlatformThemeIdSchema = z
  .enum(["compro", "sales", "travel", "catalog", "resto", "dealer"])
  .meta({ description: "Built-in platform theme identifier (PLAN §7.3)." });

export const ThemeIdSchema = z
  .string()
  .regex(
    /^(?:compro|sales|travel|catalog|resto|dealer|custom-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)$/,
    "Theme ID must be a platform theme or custom-<slug>",
  )
  .meta({ description: "Registered theme ID (built-in or granted custom-<slug>)." });

export const ApiErrorCodeSchema = z
  .enum([
    "BAD_REQUEST",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "STALE_VERSION",
    "PAYLOAD_TOO_LARGE",
    "UNSUPPORTED_MEDIA_TYPE",
    "VALIDATION_ERROR",
    "RATE_LIMITED",
    "SERVICE_UNAVAILABLE",
    "SUBSCRIPTION_LOCKED",
    "STORAGE_QUOTA_EXCEEDED",
    "MEMBER_LIMIT_REACHED",
    "DOMAIN_LOCKED",
    "TRIAL_DOMAIN_FORBIDDEN",
    "IDEMPOTENCY_CONFLICT",
    "TOTP_REQUIRED",
    "REAUTH_REQUIRED",
  ])
  .meta({ description: "Machine-readable application error code (PLAN §6)." });

export const ApiErrorFieldSchema = z
  .object({
    field: z.string().min(1).max(120),
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(300),
  })
  .strict()
  .meta({ description: "Per-field validation error item." });

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: ApiErrorCodeSchema,
        message: z.string().min(1).max(500),
        fields: z.array(ApiErrorFieldSchema).max(50).optional(),
      })
      .strict(),
    requestId: z.string().min(1).max(128),
  })
  .strict()
  .meta({ description: "Standard PunyaSitus JSON error envelope without stack traces (PLAN §6)." });

export const PaginationQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .meta({ description: "Bounded cursor pagination query contract (default 20, max 100; PLAN §6)." });

export const PaginationMetaSchema = z
  .object({
    nextCursor: z.string().min(1).max(256).nullable(),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
  })
  .strict()
  .meta({ description: "Cursor pagination response metadata." });

export function createPaginatedResponseSchema<T extends z.ZodType>(
  itemSchema: T,
  description: string,
) {
  return z
    .object({
      items: z.array(itemSchema),
      page: PaginationMetaSchema,
    })
    .strict()
    .meta({ description });
}

export const PublicSeoMetaSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(500).nullable(),
    canonicalUrl: HttpsUrlSchema,
    ogTitle: z.string().max(200).nullable(),
    ogDescription: z.string().max(500).nullable(),
    ogImageUrl: HttpsUrlSchema.nullable(),
    noindex: z.boolean(),
    nofollow: z.boolean(),
    schemaType: z.string().min(1).max(64).nullable(),
  })
  .strict()
  .meta({ description: "Resolved public SEO and social metadata DTO (PLAN §15.3)." });

export const PublicMediaAssetSchema = z
  .object({
    url: HttpsUrlSchema,
    alt: z.string().max(250),
    width: z.number().int().min(1).max(16_384),
    height: z.number().int().min(1).max(16_384),
    srcset: z.array(z.string().min(1).max(2100)).max(8).optional(),
  })
  .strict()
  .meta({ description: "Public responsive WebP media asset DTO." });

export const PublicDtoMetaSchema = z
  .object({
    revision: VersionSchema,
    publishedAt: IsoDatetimeSchema,
    primaryOrigin: HttpsUrlSchema,
  })
  .strict()
  .meta({ description: "Publication revision metadata shared across headless public DTOs." });

export const HostScopedAnonymousHeadersSchema = z
  .object({
    origin: z.string().max(256).optional(),
    secFetchSite: z.enum(["same-origin", "same-site", "cross-site", "none"]).optional(),
    contentType: z.enum([
      "application/json",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
    ]),
    idempotencyKey: IdempotencyKeySchema.optional(),
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .meta({
    description:
      "Validated headers for host-scoped anonymous tenant POST endpoints (PLAN §6).",
  });

export const PublicOriginCheckInputSchema = z
  .object({
    origin: z.string().max(256).nullable(),
    secFetchSite: z.enum(["same-origin", "same-site", "cross-site", "none"]).nullable(),
    contentType: z.enum([
      "application/json",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
    ]),
    resolvedTenantOrigin: HttpsUrlSchema,
  })
  .strict()
  .meta({ description: "Origin policy evaluation input for public tenant POST requests (PLAN §6)." });

export type PublicOriginCheckResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly status: 403; readonly reason: string };

/**
 * Enforces PLAN §6 public POST origin policy:
 * - A literal "null" Origin is rejected (403).
 * - A present Origin must strictly equal the resolved tenant origin (403 otherwise).
 * - A missing Origin is accepted only for progressive-enhancement form POSTs
 *   whose Sec-Fetch-Site (when present) is "same-origin".
 */
export function evaluatePublicPostOriginPolicy(
  input: z.infer<typeof PublicOriginCheckInputSchema>,
): PublicOriginCheckResult {
  const parsed = PublicOriginCheckInputSchema.parse(input);
  if (parsed.origin !== null) {
    if (parsed.origin.toLowerCase() === "null") {
      return { allowed: false, status: 403, reason: "Literal null Origin is forbidden" };
    }
    if (parsed.origin !== parsed.resolvedTenantOrigin) {
      return {
        allowed: false,
        status: 403,
        reason: "Origin header does not match resolved tenant origin",
      };
    }
    return { allowed: true };
  }

  if (parsed.contentType === "application/json") {
    return {
      allowed: false,
      status: 403,
      reason: "JSON public POST requests require an exact same-origin Origin header",
    };
  }

  if (parsed.secFetchSite !== null && parsed.secFetchSite !== "same-origin") {
    return {
      allowed: false,
      status: 403,
      reason: "Cross-origin form POST rejected by Sec-Fetch-Site",
    };
  }

  return { allowed: true };
}

export type HttpMethod = "get" | "post" | "patch" | "put" | "delete";

export interface RouteParameterContract {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly required: boolean;
  readonly description: string;
  readonly schema: z.ZodType;
}

export interface RouteContract {
  readonly path: string;
  readonly method: HttpMethod;
  readonly operationId: string;
  readonly tag: string;
  readonly summary: string;
  readonly description?: string;
  readonly surface: z.infer<typeof SurfaceKindSchema>;
  readonly auth: "app_session" | "console_session" | "anonymous_tenant_host";
  readonly requiredRoles: readonly z.infer<typeof RoleSchema>[];
  readonly requiredPermission?: string;
  readonly parameters?: readonly RouteParameterContract[];
  readonly requestBodySchemaId?: string;
  readonly requestBodyContentTypes?: readonly string[];
  readonly successStatus: 200 | 201 | 202 | 204;
  readonly successSchemaId?: string;
  readonly errorStatuses: readonly (400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 503)[];
  readonly rateLimited?: boolean;
  readonly idempotent?: boolean;
}

export interface DomainSchemaModule {
  readonly schemas: Readonly<Record<string, z.ZodType>>;
  readonly routes: readonly RouteContract[];
}

export const TENANT_HANDLE_PATH_PARAM: RouteParameterContract = {
  name: "tenantId",
  in: "path",
  required: true,
  description:
    "Immutable tenant handle selector (3-40 lowercase chars, PLAN §6 & §7.1). Selector only; never authorization.",
  schema: TenantHandleSchema,
};

export const RESOURCE_ID_PATH_PARAM: RouteParameterContract = {
  name: "resourceId",
  in: "path",
  required: true,
  description: "Per-tenant sequential positive integer resource identifier (PLAN §7.1).",
  schema: SequentialIdSchema,
};

export const IDEMPOTENCY_HEADER_PARAM: RouteParameterContract = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  description: "Fresh UUID per attempt; retained on retries to guarantee deduplication.",
  schema: IdempotencyKeySchema,
};

export const COMMON_COMPONENT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  ApiErrorCode: ApiErrorCodeSchema,
  ApiErrorField: ApiErrorFieldSchema,
  ApiError: ApiErrorSchema,
  PaginationQuery: PaginationQuerySchema,
  PaginationMeta: PaginationMetaSchema,
  TenantHandle: TenantHandleSchema,
  TenantStatus: TenantStatusSchema,
  SurfaceKind: SurfaceKindSchema,
  Role: RoleSchema,
  TenantMemberRole: TenantMemberRoleSchema,
  OfferingType: OfferingTypeSchema,
  PriceMode: PriceModeSchema,
  OfferingCtaKind: OfferingCtaKindSchema,
  VehicleUnitStatus: VehicleUnitStatusSchema,
  PlatformThemeId: PlatformThemeIdSchema,
  ThemeId: ThemeIdSchema,
  PublicSeoMeta: PublicSeoMetaSchema,
  PublicMediaAsset: PublicMediaAssetSchema,
  PublicDtoMeta: PublicDtoMetaSchema,
  HostScopedAnonymousHeaders: HostScopedAnonymousHeadersSchema,
  PublicOriginCheckInput: PublicOriginCheckInputSchema,
};

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type TenantMemberRole = z.infer<typeof TenantMemberRoleSchema>;
export type TenantStatus = z.infer<typeof TenantStatusSchema>;
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;
export type OfferingType = z.infer<typeof OfferingTypeSchema>;
