import {
  assertAdminCsrfAndOrigin,
  AuthorizationError,
  createAuth,
  enforceSessionLifetimeCeiling,
  resolveAuthorizedTenantMember,
  type AuthorizedTenantMember,
  type PermissionAction,
} from "@punyasitus/auth";
import { CatalogValidationError } from "@punyasitus/core/catalog/index";
import {
  PublicationAtomicError,
  PublicationNotFoundError,
  PublicationValidationError,
  StaleRevisionError,
} from "@punyasitus/core/content/index";
import {
  buildPreviewResponseHeaders,
  MAX_PREVIEW_HTML_BYTES,
  neutralizePreviewHtml,
  PREVIEW_API_CSP_HEADER,
  PREVIEW_IFRAME_SANDBOX,
  PreviewPayloadTooLargeError,
} from "@punyasitus/core/preview/index";
import {
  buildVerticalStarterComposition,
  detectSampleClaimsInSection,
  PresetDomainError,
  PreviewStarterPresetInputSchema,
  resolveCanonicalVerticalPresetId,
} from "@punyasitus/core/presets/index";
import { FORBIDDEN_TENANT_SELECTOR_KEYS } from "@punyasitus/core/schemas";
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
  applyVerticalStarterPresetAtomically,
  loadVerticalPresetDashboardState,
  markStarterPresetPreviewed,
  publishVerticalStarterPresetSectionsAtomically,
  updateStarterPresetDraftAtomically,
  type PresetMemberScope,
} from "@punyasitus/db/presets/index";
import { loadPublishedTenantShellData } from "../../../../core/public-data.ts";
import {
  resolveAuthEmailPort,
  resolvePlatformAuthHostContext,
  resolveSurfaceAuthSecret,
  type AuthRuntimeEnv,
} from "../../../../middleware/auth.ts";

/**
 * Runtime-Agnostic CSRF-Protected API Handler for Dashboard Onboarding Vertical Presets
 * (`/dashboard/[handle]/onboarding/api`; TASK-066, REQ-047, REQ-028..030, REQ-034, REQ-036).
 *
 * Security Invariants:
 * 1. Host isolation (`app` surface only -> neutral `404` on tenant/console/marketing hosts).
 * 2. CSRF & Origin enforcement (`assertAdminCsrfAndOrigin` on POST/PATCH).
 * 3. Better Auth session + lifetime ceiling enforcement (`401 UNAUTHENTICATED`).
 * 4. Live `PLATFORM_DB` membership + RBAC (`settings:read` / `settings:write`: owner/admin ONLY;
 *    editor -> `403 FORBIDDEN`, cross-tenant -> `404 NOT_FOUND`, locked -> `403` on writes).
 * 5. Strict JSON parsing rejecting oversized bodies, unknown keys, and forbidden tenant selectors.
 */

const NO_STORE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

const MAX_BODY_BYTES = 131_072; // 128 KiB
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
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
]);

const ALLOWED_ACTION_BODY_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  apply: new Set(["action", "presetId", "setupKey", "operationKey", "applyMode", "confirmSwitch"]),
  preview: new Set(["action", "presetId", "selectedSectionIds"]),
  save_draft: new Set(["action", "expectedVersion", "sections", "selectedPublishSectionIds"]),
  publish: new Set(["action", "presetId", "selectedSectionIds", "expectedVersion", "confirm"]),
};

export interface DashboardOnboardingRuntimeEnv extends AuthRuntimeEnv {
  readonly TENANT_STORE?: TenantStoreNamespaceLike | null;
}

export interface DashboardOnboardingHandlerOptions {
  readonly nowMs?: number;
  readonly requestId?: string;
  readonly authenticatedUser?: { readonly id: string } | null;
  readonly authenticatedSessionId?: string | null;
  readonly activeOrganizationId?: string | null;
  readonly resolveTenantDb?: (tenantId: string) => Promise<D1Database> | D1Database;
}

function createRequestId(): string {
  try {
    return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  } catch {
    return `req_${Date.now().toString(36)}`;
  }
}

function jsonRes(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((v, k) => headers.set(k, v));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function errorRes(
  status: number,
  code: string,
  message: string,
  requestId: string,
  extra?: { readonly fields?: readonly unknown[]; readonly extraHeaders?: HeadersInit },
): Response {
  return jsonRes(
    status,
    {
      error: {
        code,
        message,
        ...(extra?.fields && extra.fields.length > 0 ? { fields: extra.fields } : {}),
      },
      requestId,
    },
    extra?.extraHeaders,
  );
}

function findForbiddenSelectorPath(value: unknown, prefix = ""): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findForbiddenSelectorPath(value[i], `${prefix}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key)) return nextPath;
    const hit = findForbiddenSelectorPath(nested, nextPath);
    if (hit) return hit;
  }
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderVerticalSectionPreviewBlock(
  section: AnyValidatedPageSection,
  containsSample: boolean,
): string {
  const cfg = section.config as Record<string, unknown>;
  const eyebrow = typeof cfg.eyebrow === "string" ? cfg.eyebrow : "";
  const heading = typeof cfg.heading === "string" ? cfg.heading : section.type;
  const subheading = typeof cfg.subheading === "string" ? cfg.subheading : "";
  const badge = containsSample
    ? `<span class="ps-sample-pill">Draf CONTOH — Belum Diterbitkan</span>`
    : `<span class="ps-ready-pill">Siap Diterbitkan</span>`;

  let innerHtml: string;
  if (section.type === "about" || section.type === "rich_text") {
    innerHtml = `<div class="ps-prose">${section.config.bodyHtml}</div>`;
  } else if (section.type === "features" || section.type === "highlights") {
    const items = section.config.items;
    innerHtml =
      items.length > 0
        ? `<ol class="ps-steps">${items
            .map(
              (item) =>
                `<li><strong>${escapeHtml(item.title)}</strong>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}</li>`,
            )
            .join("")}</ol>`
        : `<p class="ps-empty">Langkah kerja akan tampil di sini.</p>`;
  } else if (section.type === "faq") {
    innerHtml =
      section.config.items.length > 0
        ? section.config.items
            .map(
              (item) =>
                `<details class="ps-faq"><summary>${escapeHtml(item.question)}</summary><p>${escapeHtml(item.answer)}</p></details>`,
            )
            .join("")
        : `<p class="ps-empty">Belum ada daftar FAQ.</p>`;
  } else if (
    section.type === "services_grid" ||
    section.type === "products_grid" ||
    section.type === "tours_grid" ||
    section.type === "offerings_grid" ||
    section.type === "vehicles_grid"
  ) {
    innerHtml = `<p class="ps-empty">${escapeHtml(section.config.emptyMessage ?? "Item katalog terbit Anda akan tampil otomatis di sini.")}</p>`;
  } else if (section.type === "branches" || section.type === "contact_location" || section.type === "contact") {
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
        : `<p class="ps-empty">Data cabang atau kontak resmi akan tampil di sini setelah Anda lengkapi dan terbitkan.</p>`;
  } else {
    innerHtml = `<p class="ps-empty">Bagian opsional — tidak ada klaim atau gambar fiktif yang disisipkan.</p>`;
  }

  return `<section class="ps-section" data-section-id="${escapeHtml(section.id)}" data-section-type="${escapeHtml(section.type)}">
    <div class="ps-wrap">
      <div class="ps-section-head">
        ${eyebrow ? `<span class="ps-eyebrow">${escapeHtml(eyebrow)}</span>` : ""}
        ${badge}
      </div>
      <h2>${escapeHtml(heading)}</h2>
      ${subheading ? `<p class="ps-sub">${escapeHtml(subheading)}</p>` : ""}
      ${innerHtml}
    </div>
  </section>`;
}

function toMemberScope(member: AuthorizedTenantMember): PresetMemberScope {
  return {
    tenantId: member.tenantId,
    handle: member.handle,
    tenantName: member.tenantName,
    userId: member.userId,
    role: member.role,
    tenantStatus: member.tenantStatus,
  };
}

function mapDomainError(err: unknown, requestId: string): Response {
  if (err instanceof PresetDomainError) {
    return errorRes(err.httpStatus, err.code, err.message, requestId, { fields: err.fields });
  }
  if (err instanceof SectionRegistryValidationError) {
    return errorRes(422, "VALIDATION_ERROR", err.message, requestId, { fields: err.fields });
  }
  if (err instanceof CatalogValidationError) {
    return errorRes(422, "VALIDATION_ERROR", err.message, requestId, { fields: err.fields });
  }
  if (err instanceof PublicationValidationError) {
    return errorRes(422, "VALIDATION_ERROR", err.message, requestId, { fields: err.fields });
  }
  if (err instanceof StaleRevisionError) {
    return errorRes(409, "STALE_VERSION", err.message, requestId);
  }
  if (err instanceof PublicationNotFoundError) {
    return errorRes(404, "NOT_FOUND", err.message, requestId);
  }
  if (err instanceof PreviewPayloadTooLargeError) {
    return errorRes(413, "PAYLOAD_TOO_LARGE", err.message, requestId);
  }
  if (err instanceof AuthorizationError) {
    return errorRes(err.status, err.code, err.message, requestId);
  }
  if (err instanceof PublicationAtomicError) {
    return errorRes(503, "SERVICE_UNAVAILABLE", err.message, requestId, {
      extraHeaders: { "Retry-After": "60" },
    });
  }
  return errorRes(
    503,
    "SERVICE_UNAVAILABLE",
    "Terjadi gangguan sementara saat memproses preset onboarding.",
    requestId,
    { extraHeaders: { "Retry-After": "60" } },
  );
}

export async function handleDashboardOnboardingApiRequest(
  rawHandle: string,
  request: Request,
  runtimeEnv: DashboardOnboardingRuntimeEnv,
  options: DashboardOnboardingHandlerOptions = {},
): Promise<Response> {
  const requestId = options.requestId ?? createRequestId();
  const method = request.method.toUpperCase();
  const normalizedHandle = rawHandle.trim().toLowerCase();

  // 1. Platform `app` host isolation
  const hostCtx = resolvePlatformAuthHostContext(request, runtimeEnv);
  if (!hostCtx.allowed || hostCtx.surface !== "app" || !HANDLE_RE.test(normalizedHandle)) {
    return errorRes(404, "NOT_FOUND", "Endpoint tidak ditemukan.", requestId);
  }

  if (method !== "GET" && method !== "POST") {
    return errorRes(405, "BAD_REQUEST", "Metode HTTP harus GET atau POST.", requestId, {
      extraHeaders: { Allow: "GET, POST" },
    });
  }

  // 2. CSRF & Origin check on state-changing method
  if (method === "POST") {
    const csrf = assertAdminCsrfAndOrigin(request, hostCtx.expectedOrigin);
    if (!csrf.ok) {
      return errorRes(csrf.status, csrf.code, csrf.reason, requestId);
    }
  }

  if (!runtimeEnv.PLATFORM_DB) {
    return errorRes(
      503,
      "SERVICE_UNAVAILABLE",
      "Layanan basis data platform sementara tidak tersedia.",
      requestId,
      { extraHeaders: { "Retry-After": "60" } },
    );
  }

  // 3. Authenticate Better Auth session + enforce lifetime ceiling BEFORE parsing body (fail-closed!)
  let userId: string | null = options.authenticatedUser?.id ?? null;
  let activeOrganizationId: string | null = options.activeOrganizationId ?? null;
  const pathname = new URL(request.url).pathname.toLowerCase();

  if (userId) {
    // HIGH-2: NEVER skip `enforceSessionLifetimeCeiling` when `userId` is set without `authenticatedSessionId`!
    if (!options.authenticatedSessionId) {
      return errorRes(
        401,
        "UNAUTHENTICATED",
        "Sesi login tidak lengkap atau telah berakhir. Silakan masuk kembali.",
        requestId,
      );
    }
    try {
      const lifetime = await enforceSessionLifetimeCeiling(runtimeEnv.PLATFORM_DB, {
        sessionId: options.authenticatedSessionId,
        userId,
        surface: "app",
        pathname,
        nowMs: options.nowMs,
      });
      if (!lifetime.valid) {
        userId = null;
        activeOrganizationId = null;
      }
    } catch {
      return errorRes(503, "SERVICE_UNAVAILABLE", "Verifikasi sesi sementara tidak tersedia.", requestId);
    }
  } else {
    const secret = resolveSurfaceAuthSecret("app", runtimeEnv);
    if (!secret) {
      return errorRes(503, "SERVICE_UNAVAILABLE", "Konfigurasi autentikasi belum lengkap.", requestId);
    }
    try {
      const auth = createAuth(runtimeEnv.PLATFORM_DB, {
        baseURL: hostCtx.baseURL,
        secret,
        surface: "app",
        trustedOrigins: [hostCtx.expectedOrigin],
        emailPort: resolveAuthEmailPort(runtimeEnv, null),
      });
      const sessionResult = await auth.api.getSession({ headers: request.headers });
      if (sessionResult?.user && sessionResult.session) {
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
      return errorRes(503, "SERVICE_UNAVAILABLE", "Verifikasi sesi sementara tidak tersedia.", requestId);
    }
  }

  if (!userId) {
    return errorRes(401, "UNAUTHENTICATED", "Sesi login diperlukan.", requestId);
  }

  // 4. Parse body on POST to determine exact required permission (`preview` = read, mutations = write)
  let rawBody: Record<string, unknown> = {};
  let action: "apply" | "preview" | "save_draft" | "publish" | null = null;

  if (method === "POST") {
    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader) {
      const declaredBytes = Number(contentLengthHeader);
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
        return errorRes(413, "PAYLOAD_TOO_LARGE", "Ukuran payload melebihi batas maksimum.", requestId);
      }
    }

    let rawBytes: Uint8Array;
    try {
      rawBytes = new Uint8Array(await request.arrayBuffer());
    } catch {
      return errorRes(400, "BAD_REQUEST", "Gagal membaca body permintaan.", requestId);
    }
    if (rawBytes.byteLength > MAX_BODY_BYTES) {
      return errorRes(413, "PAYLOAD_TOO_LARGE", "Ukuran payload melebihi batas maksimum.", requestId);
    }
    const rawText = new TextDecoder().decode(rawBytes).trim();
    if (!rawText) {
      return errorRes(400, "BAD_REQUEST", "Body JSON tidak boleh kosong.", requestId);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return errorRes(400, "BAD_REQUEST", "Format JSON tidak valid.", requestId);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return errorRes(422, "VALIDATION_ERROR", "Payload JSON harus berupa objek.", requestId);
    }
    rawBody = parsed as Record<string, unknown>;

    const forbiddenPath = findForbiddenSelectorPath(rawBody);
    if (forbiddenPath) {
      return errorRes(
        422,
        "VALIDATION_ERROR",
        `Properti selector terlarang "${forbiddenPath}" tidak diperbolehkan.`,
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
      );
    }

    const rawAction = typeof rawBody.action === "string" ? rawBody.action.trim() : "";
    if (
      rawAction !== "apply" &&
      rawAction !== "preview" &&
      rawAction !== "save_draft" &&
      rawAction !== "publish"
    ) {
      return errorRes(
        422,
        "VALIDATION_ERROR",
        'Aksi harus berupa "apply", "preview", "save_draft", atau "publish".',
        requestId,
      );
    }
    action = rawAction;

    const allowedKeys = ALLOWED_ACTION_BODY_KEYS[action]!;
    const unknownFields = Object.keys(rawBody)
      .filter((k) => !allowedKeys.has(k))
      .map((k) => ({
        field: k,
        code: "UNKNOWN_FIELD",
        message: `Properti "${k}" tidak dikenali.`,
      }));
    if (unknownFields.length > 0) {
      return errorRes(
        422,
        "VALIDATION_ERROR",
        "Payload mengandung properti yang tidak dikenali.",
        requestId,
        { fields: unknownFields },
      );
    }
  }

  // 5. Live membership + RBAC + tenant lifecycle status verification
  const requiredPermission: PermissionAction =
    method === "GET" || action === "preview" ? "settings:read" : "settings:write";

  let member: AuthorizedTenantMember;
  try {
    member = await resolveAuthorizedTenantMember(runtimeEnv.PLATFORM_DB, {
      userId,
      handle: normalizedHandle,
      requiredPermission,
      surface: "app",
      claimedOrganizationId: activeOrganizationId,
      nowMs: options.nowMs,
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return errorRes(err.status, err.code, err.message, requestId);
    }
    return errorRes(404, "NOT_FOUND", "Workspace tidak ditemukan.", requestId);
  }

  if (member.handle.toLowerCase() !== normalizedHandle) {
    return errorRes(404, "NOT_FOUND", "Workspace tidak ditemukan.", requestId);
  }

  // 6. Open ONLY the verified tenant's isolated TenantStore
  let tenantDb: D1Database | null = null;
  if (options.resolveTenantDb) {
    tenantDb = await options.resolveTenantDb(member.tenantId);
  } else if (runtimeEnv.TENANT_STORE) {
    tenantDb = createTenantDb(openTenantStoreStub(runtimeEnv.TENANT_STORE, member.tenantId));
  }
  if (!tenantDb) {
    return errorRes(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan data tenant sementara tidak tersedia.",
      requestId,
      { extraHeaders: { "Retry-After": "60" } },
    );
  }

  const memberScope = toMemberScope(member);

  try {
    if (method === "GET") {
      const state = await loadVerticalPresetDashboardState(
        runtimeEnv.PLATFORM_DB,
        tenantDb,
        memberScope,
      );
      return jsonRes(200, state);
    }

    const stripActionField = (src: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(src)) {
        if (k !== "action") out[k] = v;
      }
      return out;
    };

    if (action === "apply") {
      const result = await applyVerticalStarterPresetAtomically(
        runtimeEnv.PLATFORM_DB,
        tenantDb,
        memberScope,
        stripActionField(rawBody),
        { nowMs: options.nowMs },
      );
      return jsonRes(200, result);
    }

    if (action === "save_draft") {
      await updateStarterPresetDraftAtomically(
        runtimeEnv.PLATFORM_DB,
        tenantDb,
        memberScope,
        stripActionField(rawBody),
        { nowMs: options.nowMs },
      );
      const nextState = await loadVerticalPresetDashboardState(
        runtimeEnv.PLATFORM_DB,
        tenantDb,
        memberScope,
      );
      return jsonRes(200, nextState);
    }

    if (action === "publish") {
      const result = await publishVerticalStarterPresetSectionsAtomically(
        runtimeEnv.PLATFORM_DB,
        tenantDb,
        memberScope,
        stripActionField(rawBody),
        { nowMs: options.nowMs },
      );
      return jsonRes(200, result);
    }

    // action === "preview" (inert script-free HTML preview for any of the 4 vertical presets)
    const parsedPreview = PreviewStarterPresetInputSchema.safeParse(stripActionField(rawBody));
    if (!parsedPreview.success) {
      return errorRes(
        422,
        "VALIDATION_ERROR",
        parsedPreview.error.issues[0]?.message ?? "Parameter pratinjau tidak valid.",
        requestId,
      );
    }

    const state = await loadVerticalPresetDashboardState(
      runtimeEnv.PLATFORM_DB,
      tenantDb,
      memberScope,
    );
    const requestedPresetId =
      resolveCanonicalVerticalPresetId(
        parsedPreview.data.presetId ?? state.setup?.presetId ?? state.recommendedPresetId,
      ) ?? null;

    if (!requestedPresetId) {
      return errorRes(
        422,
        "UNSUPPORTED_PRESET",
        `Preset "${String(parsedPreview.data.presetId)}" tidak dikenali.`,
        requestId,
      );
    }

    const candidateSections =
      state.setup && state.setup.presetId === requestedPresetId
        ? state.setup.sections.map((s) => s.section)
        : buildVerticalStarterComposition(requestedPresetId, {
            businessName: state.tenantName,
            businessCategory: state.businessCategory,
          }).sections;

    const selectedSet =
      parsedPreview.data.selectedSectionIds && parsedPreview.data.selectedSectionIds.length > 0
        ? new Set(parsedPreview.data.selectedSectionIds)
        : null;
    const sectionsToRender = selectedSet
      ? candidateSections.filter((s) => selectedSet.has(s.id))
      : candidateSections.filter((s) => s.enabled);
    const effectiveSections =
      sectionsToRender.length > 0 ? sectionsToRender : candidateSections.slice(0, 3);

    const sampleSectionIds = effectiveSections
      .filter((s) => detectSampleClaimsInSection(s).length > 0)
      .map((s) => s.id);
    const sampleSet = new Set(sampleSectionIds);

    const shell = await loadPublishedTenantShellData(tenantDb, {
      previewMode: true,
      fallbackSiteTitle: member.tenantName,
      fallbackBusinessName: member.tenantName,
    });

    const sectionsHtml = effectiveSections
      .map((section) => renderVerticalSectionPreviewBlock(section, sampleSet.has(section.id)))
      .join("\n");

    const safeThemeCss = shell.themeStyle.css.replace(/<\/style/gi, "<\\/style");
    const rawHtml = `<!doctype html>
<html lang="id" data-ps-theme="${escapeHtml(shell.baseThemeId)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Pratinjau Draf Preset (${escapeHtml(requestedPresetId)}) — ${escapeHtml(shell.site.title)}</title>
    <style>
      ${safeThemeCss}
      body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #ffffff; color: #182522; line-height: 1.55; }
      .ps-preview-banner { background: #176b51; color: #ffffff; padding: 10px 16px; font-size: 12px; font-weight: 600; }
      .ps-wrap { max-width: 960px; margin: 0 auto; padding: 0 20px; }
      .ps-section { padding: 28px 0; border-bottom: 1px solid #eef3f0; }
      .ps-section-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
      .ps-eyebrow { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #176b51; }
      .ps-sample-pill { font-size: 11px; font-weight: 600; background: #fef3c7; color: #854d0e; border: 1px solid #f59e0b; border-radius: 4px; padding: 2px 8px; }
      .ps-ready-pill { font-size: 11px; font-weight: 600; background: #e8f5ee; color: #176b51; border: 1px solid #a7d7bf; border-radius: 4px; padding: 2px 8px; }
      .ps-sub { color: #52635c; margin-top: 6px; max-width: 65ch; }
      .ps-empty { background: #f8faf9; border: 1px dashed #d9e2dd; border-radius: 6px; padding: 12px 14px; font-size: 13px; color: #52635c; }
      .ps-steps { padding-left: 20px; }
      .ps-steps li { margin-bottom: 8px; }
    </style>
  </head>
  <body data-preview="true">
    <div class="ps-preview-banner">PRATINJAU DRAF PRESET (${escapeHtml(requestedPresetId)}) — Belum diterbitkan ke situs publik</div>
    <main>${sectionsHtml}</main>
  </body>
</html>`;

    const inertHtml = neutralizePreviewHtml(rawHtml);
    const htmlBytes = new TextEncoder().encode(inertHtml).byteLength;
    if (htmlBytes > MAX_PREVIEW_HTML_BYTES) {
      throw new PreviewPayloadTooLargeError(htmlBytes, MAX_PREVIEW_HTML_BYTES);
    }

    if (state.setup && state.permissions.canMutate) {
      await markStarterPresetPreviewed(tenantDb, options.nowMs ?? Date.now());
    }

    const previewHeaders = buildPreviewResponseHeaders({
      contentType: "application/json; charset=utf-8",
      csp: PREVIEW_API_CSP_HEADER,
    });
    return new Response(
      JSON.stringify({
        html: inertHtml,
        presetId: requestedPresetId,
        sandbox: PREVIEW_IFRAME_SANDBOX,
        isPreview: true,
        renderedSectionIds: effectiveSections.map((s) => s.id),
        sampleSectionIds,
        hasSampleContent: sampleSectionIds.length > 0,
        version: state.setup?.version ?? 0,
      }),
      { status: 200, headers: previewHeaders },
    );
  } catch (err) {
    return mapDomainError(err, requestId);
  }
}
