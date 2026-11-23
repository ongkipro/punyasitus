import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
  type PermissionAction,
} from "@punyasitus/auth";
import {
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  StaleRevisionError,
} from "@punyasitus/core/content/index";
import type { EmailPort } from "@punyasitus/core/email/index";
import {
  buildPreviewResponseHeaders,
  MAX_PREVIEW_HTML_BYTES,
  neutralizePreviewHtml,
  PREVIEW_API_CSP_HEADER,
  PREVIEW_IFRAME_SANDBOX,
  PreviewPayloadTooLargeError,
} from "@punyasitus/core/preview/index";
import {
  buildCompanyProfileStarterComposition,
  detectSampleClaimsInSection,
  isM1AvailablePresetId,
  PresetDomainError,
  PreviewStarterPresetInputSchema,
  type PresetErrorCode,
} from "@punyasitus/core/presets/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS, type ApiErrorCode } from "@punyasitus/core/schemas";
import {
  SectionRegistryValidationError,
  type AnyValidatedPageSection,
} from "@punyasitus/core/theme/sections";
import {
  createTenantDb,
  openTenantStoreStub,
  type TenantStoreNamespaceLike,
} from "@punyasitus/db/connections";
import {
  loadTenantPresetState,
  markStarterPresetPreviewed,
  type PresetMemberScope,
} from "@punyasitus/db/presets/index";
import { loadPublishedTenantShellData } from "../../../../../core/public-data.ts";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../../middleware/auth.ts";

/**
 * Shared authorization, strict JSON body parsing, error mapping, and inert draft
 * preview rendering for `/api/tenants/:tenantId/presets/**`
 * (REQ-047, REQ-019, REQ-034, REQ-036; PLAN §11.4 & §14; TASK-043).
 */

export const MAX_PRESETS_BODY_BYTES = 131_072 as const; // 128 KiB ceiling
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const PRESETS_FORBIDDEN_SELECTOR_KEYS = [
  ...FORBIDDEN_TENANT_SELECTOR_KEYS,
  "userId",
  "user_id",
  "ownerId",
  "owner_id",
  "role",
  "roles",
  "actorId",
  "actor_id",
  "platformOperator",
  "isSuperadmin",
] as const;

const FORBIDDEN_SELECTOR_KEY_SET: ReadonlySet<string> = new Set(PRESETS_FORBIDDEN_SELECTOR_KEYS);

export const PRESETS_APPLY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "presetId",
  "operationKey",
  "applyMode",
]);

export const PRESETS_DRAFT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "expectedVersion",
  "sections",
  "selectedPublishSectionIds",
]);

export const PRESETS_PREVIEW_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "presetId",
  "selectedSectionIds",
]);

export const PRESETS_PUBLISH_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "presetId",
  "selectedSectionIds",
  "expectedVersion",
  "confirm",
]);

export const PRESETS_NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export type PresetsApiErrorCode = ApiErrorCode | PresetErrorCode;

export interface TenantPresetsRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface TenantPresetsHandlerOptions {
  readonly emailPort?: EmailPort | null;
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

export interface AuthorizedPresetsRequestContext {
  readonly requestId: string;
  readonly member: AuthorizedTenantMember;
  readonly platformDb: D1Database;
  readonly tenantDb: D1Database;
}

export interface PresetPreviewResultDto {
  readonly html: string;
  readonly presetId: string;
  readonly sandbox: typeof PREVIEW_IFRAME_SANDBOX;
  readonly isPreview: true;
  readonly renderedSectionIds: readonly string[];
  readonly sampleSectionIds: readonly string[];
  readonly hasSampleContent: boolean;
  readonly version: number;
}

export function createPresetsRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

export function presetsJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(PRESETS_NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function presetsPreviewJsonResponse(
  status: number,
  body: unknown,
  extraHeaders?: HeadersInit,
): Response {
  const headers = buildPreviewResponseHeaders({
    contentType: "application/json; charset=utf-8",
    csp: PREVIEW_API_CSP_HEADER,
    extraHeaders,
  });
  return new Response(JSON.stringify(body), { status, headers });
}

export function presetsErrorResponse(
  status: number,
  code: PresetsApiErrorCode,
  message: string,
  requestId: string,
  options: {
    readonly fields?: readonly {
      readonly field: string;
      readonly code: string;
      readonly message: string;
      readonly sectionId?: string;
    }[];
    readonly extraHeaders?: HeadersInit;
  } = {},
): Response {
  return presetsJsonResponse(
    status,
    {
      error: {
        code,
        message,
        ...(options.fields && options.fields.length > 0 ? { fields: options.fields } : {}),
      },
      requestId,
    },
    options.extraHeaders,
  );
}

export function toPresetMemberScope(member: AuthorizedTenantMember): PresetMemberScope {
  return {
    tenantId: member.tenantId,
    handle: member.handle,
    tenantName: member.tenantName,
    userId: member.userId,
    role: member.role,
    tenantStatus: member.tenantStatus,
  };
}

/**
 * Enforces:
 * 1. Platform `app` host isolation (`404` on tenant/console/marketing hosts).
 * 2. CSRF & Origin check on state-changing methods (`403` on missing/mismatched Origin or non-JSON).
 * 3. Better Auth session verification + `enforceSessionLifetimeCeiling` (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership + RBAC (`owner`/`admin` only) + tenant lifecycle status gate
 *    (`404` cross-tenant/non-member, `403 FORBIDDEN` wrong role, `403 SUBSCRIPTION_LOCKED` on locked/suspended write).
 * 5. Opens ONLY the verified tenant's physically isolated `TenantStore`.
 */
export async function authorizeTenantPresetsRequest(
  tenantSelector: string,
  request: Request,
  runtimeEnv: TenantPresetsRuntimeEnv,
  requiredPermission: PermissionAction,
  options: TenantPresetsHandlerOptions = {},
): Promise<
  | { readonly ok: true; readonly ctx: AuthorizedPresetsRequestContext }
  | { readonly ok: false; readonly response: Response }
> {
  const requestId = options.requestId ?? createPresetsRequestId();

  // 1. Platform app host isolation
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app") {
    return {
      ok: false,
      response: presetsErrorResponse(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId),
    };
  }

  // 2. CSRF & Origin check on state-changing methods
  const method = request.method.toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return {
        ok: false,
        response: presetsErrorResponse(csrf.status, csrf.code, csrf.reason, requestId),
      };
    }
  }

  // 3. Fail-closed check for PLATFORM_DB
  if (!runtimeEnv.PLATFORM_DB) {
    return {
      ok: false,
      response: presetsErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Layanan basis data platform sementara tidak tersedia.",
        requestId,
        { extraHeaders: { "Retry-After": "60" } },
      ),
    };
  }

  // 4. Verify Better Auth session + lifetime ceiling
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;

  if (!userId) {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return {
        ok: false,
        response: presetsErrorResponse(
          503,
          "SERVICE_UNAVAILABLE",
          "Konfigurasi autentikasi belum lengkap.",
          requestId,
          { extraHeaders: { "Retry-After": "60" } },
        ),
      };
    }

    try {
      const auth = createAuth(runtimeEnv.PLATFORM_DB, {
        baseURL: hostCtx.baseURL,
        secret,
        surface: "app",
        trustedOrigins: [hostCtx.expectedOrigin],
        emailPort: resolveAuthEmailPort(runtimeEnv, options.emailPort),
      });
      const sessionResult = await auth.api.getSession({ headers: request.headers });
      if (sessionResult?.user && sessionResult.session) {
        const pathname = new URL(request.url).pathname.toLowerCase();
        const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
          sessionId: sessionResult.session.id,
          userId: sessionResult.user.id,
          surface: "app",
          pathname,
          nowMs: options.nowMs,
        });
        if (lifetime.valid) {
          userId = sessionResult.user.id;
          const rawSession = sessionResult.session as typeof sessionResult.session & {
            activeOrganizationId?: string | null;
          };
          activeOrganizationId = rawSession.activeOrganizationId ?? null;
        }
      }
    } catch {
      userId = null;
    }
  }

  if (!userId) {
    return {
      ok: false,
      response: presetsErrorResponse(
        401,
        "UNAUTHENTICATED",
        "Sesi Anda telah berakhir atau tidak valid. Silakan masuk kembali untuk mengelola preset.",
        requestId,
      ),
    };
  }

  // 5. Live membership + RBAC + tenant status check
  const trimmedSelector = tenantSelector.trim();
  if (!trimmedSelector) {
    return {
      ok: false,
      response: presetsErrorResponse(404, "NOT_FOUND", "Tenant tidak ditemukan.", requestId),
    };
  }

  const isUlidSelector = ULID_PATTERN.test(trimmedSelector);
  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      ...(isUlidSelector ? { tenantId: trimmedSelector } : { handle: trimmedSelector }),
      requiredPermission,
      surface: "app",
      claimedOrganizationId: activeOrganizationId,
      nowMs: options.nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        response: presetsErrorResponse(err.status, err.code, err.message, requestId),
      };
    }
    return {
      ok: false,
      response: presetsErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Gagal memverifikasi otorisasi tenant.",
        requestId,
        { extraHeaders: { "Retry-After": "60" } },
      ),
    };
  }

  // 6. Open ONLY verified tenant's isolated TenantStore
  let tenantDb: D1Database | null = null;
  if (options.resolveTenantDb) {
    tenantDb = await options.resolveTenantDb(member.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
  }

  if (!tenantDb) {
    return {
      ok: false,
      response: presetsErrorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "Penyimpanan data tenant sementara tidak tersedia.",
        requestId,
        { extraHeaders: { "Retry-After": "60" } },
      ),
    };
  }

  return {
    ok: true,
    ctx: {
      requestId,
      member,
      platformDb: runtimeEnv.PLATFORM_DB,
      tenantDb,
    },
  };
}

function findNestedForbiddenKey(value: unknown, pathPrefix = ""): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findNestedForbiddenKey(value[i], `${pathPrefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (FORBIDDEN_SELECTOR_KEY_SET.has(key)) {
      return nextPath;
    }
    const hit = findNestedForbiddenKey(nested, nextPath);
    if (hit) return hit;
  }
  return null;
}

export async function parseStrictPresetsJsonBody(
  request: Request,
  allowedKeys: ReadonlySet<string>,
  requestId: string,
  options: { readonly allowEmptyBody?: boolean } = {},
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  let rawBytes: Uint8Array;
  try {
    rawBytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return {
      ok: false,
      response: presetsErrorResponse(
        400,
        "BAD_REQUEST",
        "Gagal membaca body permintaan.",
        requestId,
      ),
    };
  }

  if (rawBytes.byteLength > MAX_PRESETS_BODY_BYTES) {
    return {
      ok: false,
      response: presetsErrorResponse(
        413,
        "PAYLOAD_TOO_LARGE",
        `Ukuran payload melebihi batas maksimum ${MAX_PRESETS_BODY_BYTES} byte.`,
        requestId,
      ),
    };
  }

  const rawText = new TextDecoder().decode(rawBytes).trim();
  if (!rawText) {
    if (options.allowEmptyBody) {
      return { ok: true, body: {} };
    }
    return {
      ok: false,
      response: presetsErrorResponse(
        400,
        "BAD_REQUEST",
        "Body JSON tidak boleh kosong.",
        requestId,
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      response: presetsErrorResponse(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId),
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      response: presetsErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Payload JSON harus berupa objek.",
        requestId,
        {
          fields: [
            { field: "body", code: "INVALID_TYPE", message: "Expected a JSON object" },
          ],
        },
      ),
    };
  }

  const obj = parsed as Record<string, unknown>;

  const forbiddenPath = findNestedForbiddenKey(obj);
  if (forbiddenPath) {
    return {
      ok: false,
      response: presetsErrorResponse(
        422,
        "VALIDATION_ERROR",
        `Properti selector terlarang "${forbiddenPath}" tidak diperbolehkan pada payload.`,
        requestId,
        {
          fields: [
            {
              field: forbiddenPath,
              code: "FORBIDDEN_SELECTOR",
              message: `Forbidden client selector "${forbiddenPath}"`,
            },
          ],
        },
      ),
    };
  }

  const unknownFields = Object.keys(obj)
    .filter((key) => !allowedKeys.has(key))
    .map((key) => ({
      field: key,
      code: "UNKNOWN_FIELD",
      message: `Properti "${key}" tidak dikenali.`,
    }));

  if (unknownFields.length > 0) {
    return {
      ok: false,
      response: presetsErrorResponse(
        422,
        "VALIDATION_ERROR",
        "Payload mengandung properti yang tidak dikenali.",
        requestId,
        { fields: unknownFields },
      ),
    };
  }

  return { ok: true, body: obj };
}

export function mapPresetsDomainErrorToResponse(err: unknown, requestId: string): Response {
  if (err instanceof PresetDomainError) {
    return presetsErrorResponse(err.httpStatus, err.code, err.message, requestId, {
      fields: err.fields,
    });
  }
  if (err instanceof SectionRegistryValidationError) {
    return presetsErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, {
      fields: err.fields.map((f) => ({
        field: f.field,
        code: f.code,
        message: f.message,
        ...(f.sectionId ? { sectionId: f.sectionId } : {}),
      })),
    });
  }
  if (err instanceof PublicationValidationError) {
    return presetsErrorResponse(422, "VALIDATION_ERROR", err.message, requestId, {
      fields: err.fields,
    });
  }
  if (err instanceof StaleRevisionError) {
    return presetsErrorResponse(409, "STALE_VERSION", err.message, requestId, {
      fields: [
        {
          field: "expectedVersion",
          code: "STALE_VERSION",
          message: err.message,
        },
      ],
    });
  }
  if (err instanceof PublicationNotFoundError) {
    return presetsErrorResponse(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof PreviewPayloadTooLargeError) {
    return presetsErrorResponse(413, "PAYLOAD_TOO_LARGE", err.message, requestId);
  }
  if (err instanceof AuthorizationError) {
    return presetsErrorResponse(err.status, err.code, err.message, requestId);
  }
  if (err instanceof PublicationAtomicError) {
    return presetsErrorResponse(
      503,
      "SERVICE_UNAVAILABLE",
      "Gagal menyelesaikan operasi preset secara atomik.",
      requestId,
      { extraHeaders: { "Retry-After": "60" } },
    );
  }
  return presetsErrorResponse(
    503,
    "SERVICE_UNAVAILABLE",
    "Terjadi gangguan sementara saat memproses preset pemula.",
    requestId,
    { extraHeaders: { "Retry-After": "60" } },
  );
}

// ---------------------------------------------------------------------------
// Inert Draft Preset Preview Renderer (PLAN §14 — zero scripts, no-store)
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderSectionPreviewBlock(
  section: AnyValidatedPageSection,
  containsSample: boolean,
): string {
  const cfg = section.config as Record<string, unknown>;
  const eyebrow = typeof cfg.eyebrow === "string" ? cfg.eyebrow : "";
  const heading = typeof cfg.heading === "string" ? cfg.heading : section.type;
  const subheading = typeof cfg.subheading === "string" ? cfg.subheading : "";
  const samplePill = containsSample
    ? `<span class="ps-sample-pill">Draf Contoh — Belum Diterbitkan</span>`
    : `<span class="ps-ready-pill">Siap Diterbitkan</span>`;

  let innerHtml = "";
  if (section.type === "about" || section.type === "rich_text") {
    innerHtml = `<div class="ps-prose">${section.config.bodyHtml}</div>`;
  } else if (section.type === "faq") {
    if (section.config.items.length === 0) {
      innerHtml = `<p class="ps-empty">Belum ada daftar pertanyaan FAQ.</p>`;
    } else {
      innerHtml = section.config.items
        .map(
          (item) =>
            `<details class="ps-faq"><summary>${escapeHtml(item.question)}</summary><p>${escapeHtml(item.answer)}</p></details>`,
        )
        .join("");
    }
  } else if (
    section.type === "services_grid" ||
    section.type === "offerings_grid" ||
    section.type === "products_grid" ||
    section.type === "tours_grid" ||
    section.type === "vehicles_grid"
  ) {
    innerHtml =
      section.config.items.length > 0
        ? `<div class="ps-grid">${section.config.items
            .map(
              (o) =>
                `<article class="ps-card"><h3>${escapeHtml(o.title)}</h3><p>${escapeHtml(o.summary ?? "")}</p></article>`,
            )
            .join("")}</div>`
        : `<p class="ps-empty">${escapeHtml(section.config.emptyMessage ?? "Daftar layanan dari Katalog Anda akan tampil di sini.")}</p>`;
  } else if (section.type === "contact_location" || section.type === "contact") {
    const lines = [
      section.config.address ? `<li><strong>Alamat:</strong> ${escapeHtml(section.config.address)}</li>` : "",
      section.config.phone ? `<li><strong>Telepon:</strong> ${escapeHtml(section.config.phone)}</li>` : "",
      section.config.whatsappPhone
        ? `<li><strong>WhatsApp:</strong> ${escapeHtml(section.config.whatsappPhone)}</li>`
        : "",
      section.config.email ? `<li><strong>Email:</strong> ${escapeHtml(section.config.email)}</li>` : "",
    ].filter(Boolean);
    innerHtml =
      lines.length > 0
        ? `<ul class="ps-contact-list">${lines.join("")}</ul>`
        : `<p class="ps-empty">Lengkapi alamat, WhatsApp, atau email bisnis di Pengaturan.</p>`;
  } else if (section.type === "gallery" || section.type === "trust_logos" || section.type === "testimonials") {
    const items = Array.isArray(cfg.items) ? cfg.items : [];
    innerHtml =
      items.length === 0
        ? `<p class="ps-empty">Bagian opsional masih kosong — tidak ada klaim atau gambar fiktif yang disisipkan.</p>`
        : `<p class="ps-meta">${items.length} item tervalidasi.</p>`;
  }

  return `<section class="ps-section" data-section-id="${escapeHtml(section.id)}" data-section-type="${escapeHtml(section.type)}">
    <div class="ps-wrap">
      <div class="ps-section-head">
        ${eyebrow ? `<span class="ps-eyebrow">${escapeHtml(eyebrow)}</span>` : ""}
        ${samplePill}
      </div>
      <h2>${escapeHtml(heading)}</h2>
      ${subheading ? `<p class="ps-sub">${escapeHtml(subheading)}</p>` : ""}
      ${innerHtml}
    </div>
  </section>`;
}

export async function renderPresetDraftPreviewResponse(
  ctx: AuthorizedPresetsRequestContext,
  rawBody: Record<string, unknown>,
  nowMs = Date.now(),
): Promise<Response> {
  const parsed = PreviewStarterPresetInputSchema.safeParse(rawBody);
  if (!parsed.success) {
    return presetsErrorResponse(
      422,
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Parameter pratinjau preset tidak valid.",
      ctx.requestId,
      {
        fields: parsed.error.issues.map((issue) => ({
          field: issue.path.join(".") || "body",
          code: "VALIDATION_ERROR",
          message: issue.message,
        })),
      },
    );
  }

  const presetId = parsed.data.presetId ?? "company_profile";
  if (!isM1AvailablePresetId(presetId)) {
    return presetsErrorResponse(
      422,
      "UNSUPPORTED_PRESET",
      `Pratinjau untuk preset "${presetId}" belum tersedia pada M1.`,
      ctx.requestId,
      {
        fields: [
          {
            field: "presetId",
            code: "UNSUPPORTED_PRESET",
            message: `Preset "${presetId}" is not available in M1`,
          },
        ],
      },
    );
  }

  const memberScope = toPresetMemberScope(ctx.member);
  const state = await loadTenantPresetState(ctx.platformDb, ctx.tenantDb, memberScope);

  // Use existing saved draft sections if initialized; otherwise preview fresh starter composition (read-only!)
  const candidateSections = state.setup
    ? state.setup.sections.map((s) => s.section)
    : buildCompanyProfileStarterComposition({
        businessName: state.tenantName,
        businessCategory: state.businessCategory,
      }).sections;

  const selectedSet =
    parsed.data.selectedSectionIds && parsed.data.selectedSectionIds.length > 0
      ? new Set(parsed.data.selectedSectionIds)
      : null;

  const sectionsToRender = selectedSet
    ? candidateSections.filter((s) => selectedSet.has(s.id))
    : candidateSections.filter((s) => s.enabled);

  const effectiveSections = sectionsToRender.length > 0 ? sectionsToRender : candidateSections.slice(0, 3);
  const sampleSectionIds = effectiveSections
    .filter((s) => detectSampleClaimsInSection(s).length > 0)
    .map((s) => s.id);
  const sampleSet = new Set(sampleSectionIds);

  const shell = await loadPublishedTenantShellData(ctx.tenantDb, {
    previewMode: true,
    fallbackSiteTitle: ctx.member.tenantName,
    fallbackBusinessName: ctx.member.tenantName,
  });

  const sectionsHtml = effectiveSections
    .map((section) => renderSectionPreviewBlock(section, sampleSet.has(section.id)))
    .join("\n");

  const rawHtml = `<!doctype html>
<html lang="id" data-ps-theme="${escapeHtml(shell.baseThemeId)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Pratinjau Draf Preset — ${escapeHtml(shell.site.title)}</title>
    <style>
      ${shell.themeStyle.css}
      body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #ffffff; color: #182522; line-height: 1.55; }
      .ps-preview-banner { background: #176b51; color: #ffffff; padding: 10px 16px; font-size: 12px; font-weight: 600; }
      .ps-wrap { max-width: 960px; margin: 0 auto; padding: 0 20px; }
      .ps-header { border-bottom: 1px solid #d9e2dd; padding: 14px 0; background: #f8faf9; }
      .ps-header-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
      .ps-section { padding: 32px 0; border-bottom: 1px solid #eef3f0; }
      .ps-section-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
      .ps-eyebrow { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #176b51; }
      .ps-sample-pill { font-size: 11px; font-weight: 600; background: #fef3c7; color: #854d0e; border: 1px solid #f59e0b; border-radius: 4px; padding: 2px 8px; }
      .ps-ready-pill { font-size: 11px; font-weight: 600; background: #e8f5ee; color: #176b51; border: 1px solid #a7d7bf; border-radius: 4px; padding: 2px 8px; }
      .ps-sub { color: #52635c; margin-top: 6px; max-width: 65ch; }
      .ps-empty { background: #f8faf9; border: 1px dashed #d9e2dd; border-radius: 6px; padding: 12px 14px; font-size: 13px; color: #52635c; }
      .ps-faq { border: 1px solid #d9e2dd; border-radius: 6px; padding: 10px 14px; margin-bottom: 8px; }
      .ps-contact-list { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 6px; font-size: 14px; }
      .ps-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
      .ps-card { border: 1px solid #d9e2dd; border-radius: 6px; padding: 14px; }
    </style>
  </head>
  <body data-preview="true" data-preset-id="${escapeHtml(presetId)}">
    <div class="ps-preview-banner">Pratinjau Draf Preset Profil Perusahaan — Belum Diterbitkan ke Situs Publik</div>
    <header class="ps-header">
      <div class="ps-wrap ps-header-row">
        <strong>${escapeHtml(shell.site.title)}</strong>
        <span>Beranda · Layanan · Kontak</span>
      </div>
    </header>
    <main>
      ${sectionsHtml}
    </main>
  </body>
</html>`;

  const inertHtml = neutralizePreviewHtml(rawHtml);
  const htmlBytes = new TextEncoder().encode(inertHtml).byteLength;
  if (htmlBytes > MAX_PREVIEW_HTML_BYTES) {
    throw new PreviewPayloadTooLargeError(htmlBytes, MAX_PREVIEW_HTML_BYTES);
  }

  // Record previewed_at ONLY when tenant is writable and setup exists (never mutates live content)
  if (state.setup && state.permissions.canMutate) {
    await markStarterPresetPreviewed(ctx.tenantDb, nowMs);
  }

  const dto: PresetPreviewResultDto = {
    html: inertHtml,
    presetId,
    sandbox: PREVIEW_IFRAME_SANDBOX,
    isPreview: true,
    renderedSectionIds: effectiveSections.map((s) => s.id),
    sampleSectionIds,
    hasSampleContent: sampleSectionIds.length > 0,
    version: state.setup?.version ?? 0,
  };

  return presetsPreviewJsonResponse(200, dto);
}
