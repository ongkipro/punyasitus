import {
  CustomFormLeadSnapshotSchema,
  DEFAULT_CONFIRMATION_MESSAGE_ID,
  DEFAULT_SUBMIT_LABEL_ID,
  getFormVerticalTemplate,
  HEALTH_CATEGORY_UUPDP_WARNING_ID,
  isHealthSensitiveBusinessCategory,
  MAX_FORMS_PER_TENANT,
  PublishedFormDefinitionSchema,
  validateFormDefinition,
  type AfterSubmitAction,
  type CustomFormField,
  type CustomFormLeadSnapshot,
  type FormValidationIssue,
  type PublishedFormDefinition,
} from "@punyasitus/core/forms/index";

/**
 * Per-Tenant Custom Forms Repository (`packages/db/src/forms/index.ts`;
 * REQ-080, PLAN §19.2, TASK-080).
 *
 * Security & Concurrency Invariants:
 * - Operates exclusively inside one tenant's physically isolated `TenantStore` DO.
 * - ZERO runtime DDL; runs seamlessly on `0001_initial_tenant` and optional `0016_custom_forms_indexes`.
 * - Enforces max 10 forms atomically inside SQLite (`WHERE (SELECT COUNT(*) FROM tenant_forms) < 10`).
 * - Enforces optimistic concurrency (`WHERE id = ? AND version = ?` with `changes() = 1`).
 * - Publishing requires non-empty `privacy_contact` on the tenant's business profile (`422 PRIVACY_CONTACT_REQUIRED`).
 * - Editing a form modifies ONLY draft columns; `published_definition_json` only changes on explicit publish,
 *   and historical `leads.form_snapshot_json` rows are NEVER modified.
 * - Every mutation writes a PII-free audit entry in `tenant_activity_log`.
 */

export class FormValidationError extends Error {
  readonly code = "VALIDATION_ERROR" as const;
  readonly status = 422 as const;
  readonly fields: readonly FormValidationIssue[];

  constructor(message: string, fields: readonly FormValidationIssue[]) {
    super(message);
    this.name = "FormValidationError";
    this.fields = fields;
  }
}

export class FormLimitExceededError extends Error {
  readonly code = "VALIDATION_ERROR" as const;
  readonly status = 422 as const;
  readonly maxForms = MAX_FORMS_PER_TENANT;

  constructor() {
    super(`Batas maksimum ${MAX_FORMS_PER_TENANT} formulir per situs telah tercapai.`);
    this.name = "FormLimitExceededError";
  }
}

export class FormPublishComplianceError extends Error {
  readonly code = "VALIDATION_ERROR" as const;
  readonly status = 422 as const;
  readonly fields: readonly FormValidationIssue[];

  constructor(message: string, fields: readonly FormValidationIssue[]) {
    super(message);
    this.name = "FormPublishComplianceError";
    this.fields = fields;
  }
}

export class FormNotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
  readonly status = 404 as const;

  constructor(selector: number | string) {
    super(`Formulir "${selector}" tidak ditemukan.`);
    this.name = "FormNotFoundError";
  }
}

export class FormSlugConflictError extends Error {
  readonly code = "CONFLICT" as const;
  readonly status = 409 as const;

  constructor(slug: string) {
    super(`Slug formulir "${slug}" sudah digunakan oleh formulir lain.`);
    this.name = "FormSlugConflictError";
  }
}

export class FormStaleVersionError extends Error {
  readonly code = "STALE_VERSION" as const;
  readonly status = 409 as const;
  readonly currentVersion: number;

  constructor(formId: number, expectedVersion: number, currentVersion: number) {
    super(
      `Versi formulir #${formId} sudah berubah (diharapkan ${expectedVersion}, saat ini ${currentVersion}). Muat ulang data terbaru sebelum menyimpan.`,
    );
    this.name = "FormStaleVersionError";
    this.currentVersion = currentVersion;
  }
}

export class FormHasLeadsError extends Error {
  readonly code = "CONFLICT" as const;
  readonly status = 409 as const;

  constructor(formId: number) {
    super(
      `Formulir #${formId} sudah memiliki pesan masuk sehingga tidak dapat dihapus permanen. Nonaktifkan formulir agar riwayat pesan tetap utuh.`,
    );
    this.name = "FormHasLeadsError";
  }
}

export class FormStorageError extends Error {
  readonly code = "SERVICE_UNAVAILABLE" as const;
  readonly status = 503 as const;

  constructor(message = "Penyimpanan data formulir sementara tidak tersedia.") {
    super(message);
    this.name = "FormStorageError";
  }
}

export interface TenantFormComplianceContext {
  readonly privacyContact: string | null;
  readonly privacyContactConfigured: boolean;
  readonly businessCategory: string;
  readonly isHealthCategory: boolean;
  readonly healthWarningMessage: string | null;
  readonly whatsappE164: string | null;
  readonly businessName: string;
}

export interface TenantFormRecord {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly submitLabel: string;
  readonly templateKey: string | null;
  readonly fields: readonly CustomFormField[];
  readonly afterSubmitAction: AfterSubmitAction;
  readonly afterSubmitConfig: {
    readonly message: string;
    readonly whatsappPhoneOverride: string | null;
    readonly whatsappIntro: string | null;
    readonly redirectUrl: string | null;
  };
  readonly publishedDefinition: PublishedFormDefinition | null;
  readonly publishedVersion: number;
  readonly publishedAt: string | null;
  readonly isPublished: boolean;
  readonly hasUnpublishedChanges: boolean;
  readonly active: boolean;
  readonly version: number;
  readonly leadsCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListTenantFormsResult {
  readonly items: readonly TenantFormRecord[];
  readonly count: number;
  readonly maxForms: typeof MAX_FORMS_PER_TENANT;
  readonly compliance: TenantFormComplianceContext;
}

interface RawTenantFormRow {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly fields_json: string;
  readonly after_submit_action: string;
  readonly after_submit_config_json: string;
  readonly published_definition_json: string | null;
  readonly published_version: number;
  readonly active: number;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly leads_count?: number;
}

interface StoredAfterSubmitEnvelope {
  readonly message?: string;
  readonly whatsappPhoneOverride?: string | null;
  readonly whatsappIntro?: string | null;
  readonly redirectUrl?: string | null;
  readonly _meta?: {
    readonly description?: string | null;
    readonly submitLabel?: string;
    readonly templateKey?: string | null;
  };
}

function safeJsonParse(raw: string | null | undefined): unknown {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isMissingTableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /no such table/i.test(msg);
}

function isUniqueConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

function parseStoredAfterSubmit(raw: string): {
  readonly message: string;
  readonly whatsappPhoneOverride: string | null;
  readonly whatsappIntro: string | null;
  readonly redirectUrl: string | null;
  readonly description: string | null;
  readonly submitLabel: string;
  readonly templateKey: string | null;
} {
  const parsed = safeJsonParse(raw) as StoredAfterSubmitEnvelope | null;
  return {
    message:
      typeof parsed?.message === "string" && parsed.message.trim().length > 0
        ? parsed.message.trim()
        : DEFAULT_CONFIRMATION_MESSAGE_ID,
    whatsappPhoneOverride:
      typeof parsed?.whatsappPhoneOverride === "string" && parsed.whatsappPhoneOverride.trim().length > 0
        ? parsed.whatsappPhoneOverride.trim()
        : null,
    whatsappIntro:
      typeof parsed?.whatsappIntro === "string" && parsed.whatsappIntro.trim().length > 0
        ? parsed.whatsappIntro.trim()
        : null,
    redirectUrl:
      typeof parsed?.redirectUrl === "string" && parsed.redirectUrl.trim().length > 0
        ? parsed.redirectUrl.trim()
        : null,
    description:
      typeof parsed?._meta?.description === "string" && parsed._meta.description.trim().length > 0
        ? parsed._meta.description.trim()
        : null,
    submitLabel:
      typeof parsed?._meta?.submitLabel === "string" && parsed._meta.submitLabel.trim().length > 0
        ? parsed._meta.submitLabel.trim()
        : DEFAULT_SUBMIT_LABEL_ID,
    templateKey:
      typeof parsed?._meta?.templateKey === "string" && parsed._meta.templateKey.trim().length > 0
        ? parsed._meta.templateKey.trim()
        : null,
  };
}

function serializeStoredAfterSubmit(input: {
  readonly message: string;
  readonly whatsappPhoneOverride: string | null;
  readonly whatsappIntro: string | null;
  readonly redirectUrl: string | null;
  readonly description: string | null;
  readonly submitLabel: string;
  readonly templateKey: string | null;
}): string {
  const envelope: StoredAfterSubmitEnvelope = {
    message: input.message,
    whatsappPhoneOverride: input.whatsappPhoneOverride,
    whatsappIntro: input.whatsappIntro,
    redirectUrl: input.redirectUrl,
    _meta: {
      description: input.description,
      submitLabel: input.submitLabel,
      templateKey: input.templateKey,
    },
  };
  return JSON.stringify(envelope);
}

function parsePublishedDefinition(raw: string | null): PublishedFormDefinition | null {
  const parsed = safeJsonParse(raw);
  if (!parsed) return null;
  const checked = PublishedFormDefinitionSchema.safeParse(parsed);
  return checked.success ? checked.data : null;
}

function computeHasUnpublishedChanges(
  draft: {
    readonly slug: string;
    readonly name: string;
    readonly description: string | null;
    readonly submitLabel: string;
    readonly fields: readonly CustomFormField[];
    readonly afterSubmitAction: AfterSubmitAction;
    readonly afterSubmitConfig: {
      readonly message: string;
      readonly whatsappPhoneOverride: string | null;
      readonly whatsappIntro: string | null;
      readonly redirectUrl: string | null;
    };
  },
  published: PublishedFormDefinition | null,
): boolean {
  if (!published) return true;
  if (
    draft.slug !== published.slug ||
    draft.name !== published.name ||
    draft.description !== published.description ||
    draft.submitLabel !== published.submitLabel ||
    draft.afterSubmitAction !== published.afterSubmitAction
  ) {
    return true;
  }
  if (
    JSON.stringify(draft.afterSubmitConfig) !== JSON.stringify(published.afterSubmitConfig)
  ) {
    return true;
  }
  return JSON.stringify(draft.fields) !== JSON.stringify(published.fields);
}

function mapRawTenantFormRow(row: RawTenantFormRow): TenantFormRecord {
  const parsedFields = safeJsonParse(row.fields_json);
  const fields: CustomFormField[] = Array.isArray(parsedFields)
    ? (parsedFields as CustomFormField[])
    : [];
  const after = parseStoredAfterSubmit(row.after_submit_config_json);
  const afterSubmitAction: AfterSubmitAction =
    row.after_submit_action === "whatsapp" || row.after_submit_action === "url"
      ? row.after_submit_action
      : "text";
  const publishedDefinition = parsePublishedDefinition(row.published_definition_json);
  const publishedVersion = Number(row.published_version) || 0;
  const active = Number(row.active) === 1;
  const isPublished = active && publishedDefinition !== null && publishedVersion >= 1;

  const afterSubmitConfig = {
    message: after.message,
    whatsappPhoneOverride: after.whatsappPhoneOverride,
    whatsappIntro: after.whatsappIntro,
    redirectUrl: after.redirectUrl,
  };

  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    description: after.description,
    submitLabel: after.submitLabel,
    templateKey: after.templateKey,
    fields,
    afterSubmitAction,
    afterSubmitConfig,
    publishedDefinition,
    publishedVersion,
    publishedAt: publishedDefinition?.publishedAt ?? null,
    isPublished,
    hasUnpublishedChanges: computeHasUnpublishedChanges(
      {
        slug: row.slug,
        name: row.name,
        description: after.description,
        submitLabel: after.submitLabel,
        fields,
        afterSubmitAction,
        afterSubmitConfig,
      },
      publishedDefinition,
    ),
    active,
    version: Number(row.version),
    leadsCount: Number(row.leads_count ?? 0),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
  };
}

/**
 * Resolves the tenant's UU PDP compliance & business contact context from `TenantStore`:
 * - Checks PUBLISHED `privacy_contact` ONLY (`business_profile_structured.published_json`, or
 *   `business_profile.published_json` on legacy 0001 DBs without migration 0011) so an
 *   unpublished draft privacy contact can NEVER unlock publishing a public form.
 * - Checks `business_profile` against regulated health verticals (`medical_clinic`,
 *   `dentist`, `health_and_beauty`) for the UU PDP sensitive-data warning.
 */
export async function getTenantFormComplianceContext(
  tenantDb: D1Database,
): Promise<TenantFormComplianceContext> {
  let businessCategory = "LocalBusiness";
  let whatsappE164: string | null = null;
  let businessName = "Bisnis";
  let privacyContact: string | null = null;
  let publishedLegacyEmail: string | null = null;

  try {
    const bpRow = await tenantDb
      .prepare(
        `SELECT business_name, business_category, whatsapp_e164, email, published_json
         FROM business_profile
         WHERE id = 1
         LIMIT 1`,
      )
      .first<{
        readonly business_name: string | null;
        readonly business_category: string | null;
        readonly whatsapp_e164: string | null;
        readonly email: string | null;
        readonly published_json: string | null;
      }>();

    if (bpRow) {
      if (bpRow.business_name?.trim()) businessName = bpRow.business_name.trim();
      if (bpRow.business_category?.trim()) businessCategory = bpRow.business_category.trim();
      if (bpRow.whatsapp_e164?.trim()) whatsappE164 = bpRow.whatsapp_e164.trim();

      // Inspect PUBLISHED business_profile envelope ONLY (never draft_json!)
      const parsed = safeJsonParse(bpRow.published_json) as Record<string, unknown> | null;
      if (parsed && typeof parsed === "object") {
        const inner =
          parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
            ? (parsed.data as Record<string, unknown>)
            : parsed;

        if (typeof inner.businessCategory === "string" && inner.businessCategory.trim()) {
          businessCategory = inner.businessCategory.trim();
        }
        if (typeof inner.businessName === "string" && inner.businessName.trim()) {
          businessName = inner.businessName.trim();
        }
        if (typeof inner.whatsappE164 === "string" && inner.whatsappE164.trim()) {
          whatsappE164 = inner.whatsappE164.trim();
        }
        if (typeof inner.email === "string" && inner.email.trim()) {
          publishedLegacyEmail = inner.email.trim();
        }
        const fromPublished =
          typeof inner.privacyContact === "string"
            ? inner.privacyContact.trim()
            : typeof inner.privacy_contact === "string"
              ? inner.privacy_contact.trim()
              : "";
        if (fromPublished) {
          privacyContact = fromPublished;
        }
      }
    }
  } catch (err) {
    if (!isMissingTableError(err)) {
      throw new FormStorageError("Gagal membaca profil bisnis untuk validasi formulir.");
    }
  }

  let hasStructuredTable = true;
  try {
    const extRow = await tenantDb
      .prepare(
        `SELECT published_json
         FROM business_profile_structured
         WHERE id = 1
         LIMIT 1`,
      )
      .first<{
        readonly published_json: string | null;
      }>();

    if (extRow) {
      // Authoritative PUBLISHED structured extension ONLY (draft_json & unpublished columns are ignored!)
      const parsed = safeJsonParse(extRow.published_json) as Record<string, unknown> | null;
      const publishedContact =
        typeof parsed?.privacyContact === "string" && parsed.privacyContact.trim().length > 0
          ? parsed.privacyContact.trim()
          : null;
      privacyContact = publishedContact;
    } else {
      privacyContact = null;
    }
  } catch (err) {
    if (isMissingTableError(err)) {
      hasStructuredTable = false;
    } else {
      throw new FormStorageError("Gagal membaca kontak privasi bisnis.");
    }
  }

  // Only on legacy 0001 DBs where `0011_business_profile_structured` is absent,
  // allow PUBLISHED `business_profile.published_json.data.email` as privacy contact fallback.
  if (!hasStructuredTable && !privacyContact && publishedLegacyEmail) {
    privacyContact = publishedLegacyEmail;
  }

  const isHealthCategory = isHealthSensitiveBusinessCategory(businessCategory);
  return {
    privacyContact,
    privacyContactConfigured: Boolean(privacyContact && privacyContact.trim().length > 0),
    businessCategory,
    isHealthCategory,
    healthWarningMessage: isHealthCategory ? HEALTH_CATEGORY_UUPDP_WARNING_ID : null,
    whatsappE164,
    businessName,
  };
}

export async function listTenantForms(tenantDb: D1Database): Promise<ListTenantFormsResult> {
  try {
    const [rowsRes, compliance] = await Promise.all([
      tenantDb
        .prepare(
          `SELECT
             f.id, f.slug, f.name, f.fields_json, f.after_submit_action,
             f.after_submit_config_json, f.published_definition_json, f.published_version,
             f.active, f.version, f.created_at, f.updated_at,
             (SELECT COUNT(*) FROM leads l WHERE l.form_id = f.id) AS leads_count
           FROM tenant_forms f
           ORDER BY f.updated_at DESC, f.id DESC`,
        )
        .all<RawTenantFormRow>(),
      getTenantFormComplianceContext(tenantDb),
    ]);

    const items = (rowsRes.results ?? []).map(mapRawTenantFormRow);
    return {
      items,
      count: items.length,
      maxForms: MAX_FORMS_PER_TENANT,
      compliance,
    };
  } catch (err) {
    if (err instanceof FormStorageError) throw err;
    throw new FormStorageError("Gagal memuat daftar formulir tenant.");
  }
}

export async function getTenantFormById(
  tenantDb: D1Database,
  formId: number,
): Promise<{ readonly form: TenantFormRecord; readonly compliance: TenantFormComplianceContext }> {
  try {
    const [row, compliance] = await Promise.all([
      tenantDb
        .prepare(
          `SELECT
             f.id, f.slug, f.name, f.fields_json, f.after_submit_action,
             f.after_submit_config_json, f.published_definition_json, f.published_version,
             f.active, f.version, f.created_at, f.updated_at,
             (SELECT COUNT(*) FROM leads l WHERE l.form_id = f.id) AS leads_count
           FROM tenant_forms f
           WHERE f.id = ?
           LIMIT 1`,
        )
        .bind(formId)
        .first<RawTenantFormRow>(),
      getTenantFormComplianceContext(tenantDb),
    ]);

    if (!row) {
      throw new FormNotFoundError(formId);
    }

    return { form: mapRawTenantFormRow(row), compliance };
  } catch (err) {
    if (err instanceof FormNotFoundError || err instanceof FormStorageError) throw err;
    throw new FormStorageError("Gagal membaca detail formulir.");
  }
}

/**
 * Loads an active, published custom form definition by its PUBLISHED snapshot `slug`
 * for public rendering or submission.
 * - Matches STRICTLY against `json_extract(published_definition_json, '$.slug')` so draft
 *   slug renames NEVER alter or break the live public URL until explicit republish!
 * - Never returns draft-only or unpublished/inactive forms!
 */
export async function getPublishedTenantFormBySlug(
  tenantDb: D1Database,
  rawSlug: string,
): Promise<{
  readonly id: number;
  readonly slug: string;
  readonly publishedVersion: number;
  readonly definition: PublishedFormDefinition;
} | null> {
  const slug = rawSlug.trim().toLowerCase();
  if (!slug || slug.length > 80) return null;

  try {
    const row = await tenantDb
      .prepare(
        `SELECT id, published_definition_json, published_version, active
         FROM tenant_forms
         WHERE active = 1
           AND published_definition_json IS NOT NULL
           AND json_extract(published_definition_json, '$.slug') = ?
         LIMIT 1`,
      )
      .bind(slug)
      .first<{
        readonly id: number;
        readonly published_definition_json: string | null;
        readonly published_version: number;
        readonly active: number;
      }>();

    if (!row || !row.published_definition_json) return null;
    const def = parsePublishedDefinition(row.published_definition_json);
    if (!def || def.slug !== slug) return null;
    return {
      id: Number(row.id),
      slug: def.slug,
      publishedVersion: Number(row.published_version),
      definition: def,
    };
  } catch {
    throw new FormStorageError("Gagal memuat definisi formulir publik.");
  }
}

export interface CreateTenantFormInput {
  readonly payload: Record<string, unknown>;
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
  readonly nowMs?: number;
}

/**
 * Creates a new draft custom form in `TenantStore`.
 * Supports initializing from one of the 6 vertical templates when `templateKey` is supplied
 * without explicit `fields`.
 * Atomically enforces `MAX_FORMS_PER_TENANT` (10 forms) in SQLite.
 */
export async function createTenantForm(
  tenantDb: D1Database,
  input: CreateTenantFormInput,
): Promise<TenantFormRecord> {
  let candidate: Record<string, unknown> = { ...input.payload };

  // Optional template hydration if caller supplies templateKey without explicit fields
  if (
    typeof candidate.templateKey === "string" &&
    candidate.templateKey.trim().length > 0 &&
    candidate.fields === undefined
  ) {
    const tpl = getFormVerticalTemplate(candidate.templateKey);
    if (!tpl) {
      throw new FormValidationError("Template formulir tidak ditemukan.", [
        {
          field: "templateKey",
          code: "INVALID_TEMPLATE",
          message: `Template "${candidate.templateKey}" tidak tersedia.`,
        },
      ]);
    }
    candidate = {
      slug: candidate.slug ?? tpl.defaultSlug,
      name: candidate.name ?? tpl.defaultName,
      description: candidate.description ?? tpl.defaultDescription,
      submitLabel: candidate.submitLabel ?? tpl.submitLabel,
      templateKey: tpl.key,
      fields: tpl.fields,
      afterSubmitAction: candidate.afterSubmitAction ?? tpl.afterSubmitAction,
      afterSubmitConfig: candidate.afterSubmitConfig ?? tpl.afterSubmitConfig,
      active: candidate.active ?? true,
    };
  }

  const validated = validateFormDefinition(candidate);
  if (!validated.ok) {
    throw new FormValidationError(validated.message, validated.issues);
  }
  const data = validated.data;
  const nowMs = Math.floor(input.nowMs ?? Date.now());

  const fieldsJson = JSON.stringify(data.fields);
  const afterSubmitConfigJson = serializeStoredAfterSubmit({
    ...data.afterSubmitConfig,
    description: data.description,
    submitLabel: data.submitLabel,
    templateKey: data.templateKey,
  });

  try {
    // Fast precheck for clear error semantics (authoritative cap is enforced atomically in SQL below)
    const countRow = await tenantDb
      .prepare("SELECT COUNT(*) AS cnt FROM tenant_forms")
      .first<{ readonly cnt: number }>();
    if (Number(countRow?.cnt ?? 0) >= MAX_FORMS_PER_TENANT) {
      throw new FormLimitExceededError();
    }

    const batchRes = await tenantDb.batch<{ id?: number }>([
      tenantDb.prepare(
        `INSERT INTO sequences (kind, next)
         VALUES ('tenant_forms', 1)
         ON CONFLICT(kind) DO UPDATE SET next = next + 1`,
      ),
      tenantDb
        .prepare(
          `INSERT INTO tenant_forms (
             id, slug, name, fields_json, after_submit_action, after_submit_config_json,
             published_definition_json, published_version, active, version, created_at, updated_at
           )
           SELECT
             (SELECT next FROM sequences WHERE kind = 'tenant_forms'),
             ?, ?, ?, ?, ?, NULL, 0, 0, 1, ?, ?
           WHERE (SELECT COUNT(*) FROM tenant_forms) < ?
           RETURNING id`,
        )
        .bind(
          data.slug,
          data.name,
          fieldsJson,
          data.afterSubmitAction,
          afterSubmitConfigJson,
          nowMs,
          nowMs,
          MAX_FORMS_PER_TENANT,
        ),
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           )
           SELECT ?, ?, 'form.created', 'tenant_form',
                  CAST((SELECT next FROM sequences WHERE kind = 'tenant_forms') AS TEXT),
                  ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          input.actorUserId ?? null,
          input.actorRole ?? "admin",
          `Membuat formulir "${data.name}" (${data.slug})`,
          JSON.stringify({
            slug: data.slug,
            fieldCount: data.fields.length,
            afterSubmitAction: data.afterSubmitAction,
            templateKey: data.templateKey,
          }),
          nowMs,
        ),
    ]);

    const insertedId = Number(batchRes[1]?.results?.[0]?.id ?? 0);
    if (!Number.isInteger(insertedId) || insertedId < 1) {
      // Atomic WHERE COUNT(*) < 10 guard rejected a concurrent 11th form
      throw new FormLimitExceededError();
    }

    const loaded = await getTenantFormById(tenantDb, insertedId);
    return loaded.form;
  } catch (err) {
    if (
      err instanceof FormValidationError ||
      err instanceof FormLimitExceededError ||
      err instanceof FormSlugConflictError ||
      err instanceof FormStorageError
    ) {
      throw err;
    }
    if (isUniqueConstraintError(err)) {
      throw new FormSlugConflictError(data.slug);
    }
    throw new FormStorageError("Gagal menyimpan formulir baru.");
  }
}

export interface UpdateTenantFormInput {
  readonly formId: number;
  readonly expectedVersion: number;
  readonly payload: Record<string, unknown>;
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
  readonly nowMs?: number;
}

/**
 * Updates a custom form's draft configuration using atomic SQLite optimistic concurrency
 * (`WHERE id = ? AND version = ?`).
 *
 * CRITICAL INVARIANTS:
 * - Updates ONLY draft columns (`slug`, `name`, `fields_json`, `after_submit_action`,
 *   `after_submit_config_json`, `version`, `updated_at`).
 * - NEVER modifies `active` (activation/deactivation is strictly controlled by `publishTenantForm`
 *   so draft edits can NEVER bypass the publish compliance gate or reactivate unpublished forms!).
 * - NEVER alters `published_definition_json` or historical `leads.form_snapshot_json`!
 */
export async function updateTenantForm(
  tenantDb: D1Database,
  input: UpdateTenantFormInput,
): Promise<TenantFormRecord> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new FormValidationError("expectedVersion harus berupa bilangan bulat positif.", [
      {
        field: "expectedVersion",
        code: "INVALID_VERSION",
        message: "Versi data (expectedVersion) wajib disertakan untuk mencegah timpaan.",
      },
    ]);
  }

  const validated = validateFormDefinition(input.payload);
  if (!validated.ok) {
    throw new FormValidationError(validated.message, validated.issues);
  }
  const data = validated.data;
  const nowMs = Math.floor(input.nowMs ?? Date.now());

  const fieldsJson = JSON.stringify(data.fields);
  const afterSubmitConfigJson = serializeStoredAfterSubmit({
    ...data.afterSubmitConfig,
    description: data.description,
    submitLabel: data.submitLabel,
    templateKey: data.templateKey,
  });

  try {
    const batchRes = await tenantDb.batch([
      tenantDb
        .prepare(
          `UPDATE tenant_forms
           SET slug = ?,
               name = ?,
               fields_json = ?,
               after_submit_action = ?,
               after_submit_config_json = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          data.slug,
          data.name,
          fieldsJson,
          data.afterSubmitAction,
          afterSubmitConfigJson,
          nowMs,
          input.formId,
          input.expectedVersion,
        ),
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           )
           SELECT ?, ?, 'form.updated', 'tenant_form', ?, ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          input.actorUserId ?? null,
          input.actorRole ?? "admin",
          String(input.formId),
          `Memperbarui draf formulir "${data.name}" (${data.slug})`,
          JSON.stringify({
            slug: data.slug,
            fieldCount: data.fields.length,
            afterSubmitAction: data.afterSubmitAction,
            previousVersion: input.expectedVersion,
          }),
          nowMs,
        ),
    ]);

    const changed = Number(batchRes[0]?.meta?.changes ?? 0);
    if (changed !== 1) {
      const existing = await tenantDb
        .prepare("SELECT version FROM tenant_forms WHERE id = ? LIMIT 1")
        .bind(input.formId)
        .first<{ readonly version: number }>();
      if (!existing) {
        throw new FormNotFoundError(input.formId);
      }
      throw new FormStaleVersionError(input.formId, input.expectedVersion, Number(existing.version));
    }

    const loaded = await getTenantFormById(tenantDb, input.formId);
    return loaded.form;
  } catch (err) {
    if (
      err instanceof FormValidationError ||
      err instanceof FormNotFoundError ||
      err instanceof FormStaleVersionError ||
      err instanceof FormSlugConflictError ||
      err instanceof FormStorageError
    ) {
      throw err;
    }
    if (isUniqueConstraintError(err)) {
      throw new FormSlugConflictError(data.slug);
    }
    throw new FormStorageError("Gagal memperbarui formulir.");
  }
}

export interface PublishTenantFormInput {
  readonly formId: number;
  readonly expectedVersion: number;
  readonly action?: "publish" | "unpublish";
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
  readonly nowMs?: number;
}

/**
 * Publishes (or unpublishes) a custom form with atomic optimistic concurrency.
 *
 * Hard Compliance Gate (REQ-080, PLAN §19.2):
 * - Publishing is BLOCKED (`422 PRIVACY_CONTACT_REQUIRED`) while `business_profile.privacy_contact`
 *   is empty!
 * - Creates a versioned immutable `PublishedFormDefinition` snapshot in `published_definition_json`
 *   and increments `published_version` + `version` atomically.
 */
export async function publishTenantForm(
  tenantDb: D1Database,
  input: PublishTenantFormInput,
): Promise<{
  readonly form: TenantFormRecord;
  readonly compliance: TenantFormComplianceContext;
}> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new FormValidationError("expectedVersion harus berupa bilangan bulat positif.", [
      {
        field: "expectedVersion",
        code: "INVALID_VERSION",
        message: "Versi data (expectedVersion) wajib disertakan.",
      },
    ]);
  }

  const mode = input.action ?? "publish";
  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const { form: current, compliance } = await getTenantFormById(tenantDb, input.formId);

  if (current.version !== input.expectedVersion) {
    throw new FormStaleVersionError(input.formId, input.expectedVersion, current.version);
  }

  if (mode === "unpublish") {
    try {
      const batchRes = await tenantDb.batch([
        tenantDb
          .prepare(
            `UPDATE tenant_forms
             SET active = 0,
                 version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .bind(nowMs, input.formId, input.expectedVersion),
        tenantDb
          .prepare(
            `INSERT INTO tenant_activity_log (
               actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
             )
             SELECT ?, ?, 'form.unpublished', 'tenant_form', ?, ?, ?, ?
             WHERE changes() = 1`,
          )
          .bind(
            input.actorUserId ?? null,
            input.actorRole ?? "admin",
            String(input.formId),
            `Menonaktifkan formulir "${current.name}" (${current.slug})`,
            JSON.stringify({ slug: current.slug, previousVersion: input.expectedVersion }),
            nowMs,
          ),
      ]);

      if (Number(batchRes[0]?.meta?.changes ?? 0) !== 1) {
        const latest = await tenantDb
          .prepare("SELECT version FROM tenant_forms WHERE id = ? LIMIT 1")
          .bind(input.formId)
          .first<{ readonly version: number }>();
        if (!latest) throw new FormNotFoundError(input.formId);
        throw new FormStaleVersionError(input.formId, input.expectedVersion, Number(latest.version));
      }

      return getTenantFormById(tenantDb, input.formId);
    } catch (err) {
      if (
        err instanceof FormNotFoundError ||
        err instanceof FormStaleVersionError ||
        err instanceof FormStorageError
      ) {
        throw err;
      }
      throw new FormStorageError("Gagal menonaktifkan formulir.");
    }
  }

  // Publish compliance gate: privacy_contact MUST be non-empty!
  if (!compliance.privacyContactConfigured) {
    throw new FormPublishComplianceError(
      "Formulir belum dapat diterbitkan karena Kontak Privasi (UU PDP) pada Profil Bisnis masih kosong. Lengkapi Kontak Privasi di Pengaturan > Profil Bisnis terlebih dahulu.",
      [
        {
          field: "privacyContact",
          code: "PRIVACY_CONTACT_REQUIRED",
          message:
            "Kontak Privasi pada Profil Bisnis wajib diisi sebelum menerbitkan formulir publik.",
        },
      ],
    );
  }

  // Re-validate the current draft strictly before publishing
  const revalidated = validateFormDefinition({
    slug: current.slug,
    name: current.name,
    description: current.description,
    submitLabel: current.submitLabel,
    templateKey: current.templateKey,
    fields: current.fields,
    afterSubmitAction: current.afterSubmitAction,
    afterSubmitConfig: current.afterSubmitConfig,
    active: true,
  });

  if (!revalidated.ok) {
    throw new FormValidationError(revalidated.message, revalidated.issues);
  }

  const nextPublishedVersion = current.publishedVersion + 1;
  const publishedDef: PublishedFormDefinition = {
    schemaVersion: 1,
    formId: current.id,
    slug: revalidated.data.slug,
    name: revalidated.data.name,
    description: revalidated.data.description,
    submitLabel: revalidated.data.submitLabel,
    templateKey: revalidated.data.templateKey,
    fields: [...revalidated.data.fields],
    afterSubmitAction: revalidated.data.afterSubmitAction,
    afterSubmitConfig: revalidated.data.afterSubmitConfig,
    publishedVersion: nextPublishedVersion,
    publishedAt: new Date(nowMs).toISOString(),
  };

  try {
    const batchRes = await tenantDb.batch([
      tenantDb
        .prepare(
          `UPDATE tenant_forms
           SET published_definition_json = ?,
               published_version = ?,
               active = 1,
               version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ?
             AND NOT EXISTS (
               SELECT 1 FROM tenant_forms other
               WHERE other.id != ?
                 AND other.active = 1
                 AND other.published_definition_json IS NOT NULL
                 AND json_extract(other.published_definition_json, '$.slug') = ?
             )`,
        )
        .bind(
          JSON.stringify(publishedDef),
          nextPublishedVersion,
          nowMs,
          input.formId,
          input.expectedVersion,
          input.formId,
          publishedDef.slug,
        ),
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           )
           SELECT ?, ?, 'form.published', 'tenant_form', ?, ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          input.actorUserId ?? null,
          input.actorRole ?? "admin",
          String(input.formId),
          `Menerbitkan formulir "${publishedDef.name}" v${nextPublishedVersion}`,
          JSON.stringify({
            slug: publishedDef.slug,
            publishedVersion: nextPublishedVersion,
            isHealthCategory: compliance.isHealthCategory,
          }),
          nowMs,
        ),
    ]);

    if (Number(batchRes[0]?.meta?.changes ?? 0) !== 1) {
      const [latest, conflictRow] = await Promise.all([
        tenantDb
          .prepare("SELECT version FROM tenant_forms WHERE id = ? LIMIT 1")
          .bind(input.formId)
          .first<{ readonly version: number }>(),
        tenantDb
          .prepare(
            `SELECT id FROM tenant_forms
             WHERE id != ?
               AND active = 1
               AND published_definition_json IS NOT NULL
               AND json_extract(published_definition_json, '$.slug') = ?
             LIMIT 1`,
          )
          .bind(input.formId, publishedDef.slug)
          .first<{ readonly id: number }>(),
      ]);
      if (!latest) throw new FormNotFoundError(input.formId);
      if (conflictRow) throw new FormSlugConflictError(publishedDef.slug);
      throw new FormStaleVersionError(input.formId, input.expectedVersion, Number(latest.version));
    }

    return getTenantFormById(tenantDb, input.formId);
  } catch (err) {
    if (
      err instanceof FormNotFoundError ||
      err instanceof FormStaleVersionError ||
      err instanceof FormSlugConflictError ||
      err instanceof FormValidationError ||
      err instanceof FormPublishComplianceError ||
      err instanceof FormStorageError
    ) {
      throw err;
    }
    if (isUniqueConstraintError(err)) {
      throw new FormSlugConflictError(publishedDef.slug);
    }
    throw new FormStorageError("Gagal menerbitkan formulir.");
  }
}

export interface DeleteTenantFormInput {
  readonly formId: number;
  readonly expectedVersion: number;
  readonly actorUserId?: string | null;
  readonly actorRole?: string;
  readonly nowMs?: number;
}

/**
 * Deletes a form only when zero leads reference it (`leads.form_id`), preserving historical
 * lead foreign-key integrity and immutable snapshots. Enforces `expectedVersion`.
 */
export async function deleteTenantForm(
  tenantDb: D1Database,
  input: DeleteTenantFormInput,
): Promise<{ readonly deleted: true; readonly formId: number }> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new FormValidationError("expectedVersion harus berupa bilangan bulat positif.", [
      {
        field: "expectedVersion",
        code: "INVALID_VERSION",
        message: "Versi data (expectedVersion) wajib disertakan.",
      },
    ]);
  }

  const nowMs = Math.floor(input.nowMs ?? Date.now());
  const { form: existing } = await getTenantFormById(tenantDb, input.formId);
  if (existing.version !== input.expectedVersion) {
    throw new FormStaleVersionError(input.formId, input.expectedVersion, existing.version);
  }
  if (existing.leadsCount > 0) {
    throw new FormHasLeadsError(input.formId);
  }

  try {
    const batchRes = await tenantDb.batch([
      tenantDb
        .prepare(
          `DELETE FROM tenant_forms
           WHERE id = ? AND version = ?
             AND NOT EXISTS (SELECT 1 FROM leads WHERE form_id = ?)`,
        )
        .bind(input.formId, input.expectedVersion, input.formId),
      tenantDb
        .prepare(
          `INSERT INTO tenant_activity_log (
             actor_user_id, actor_role, action, resource_type, resource_id, summary, metadata_json, created_at
           )
           SELECT ?, ?, 'form.deleted', 'tenant_form', ?, ?, ?, ?
           WHERE changes() = 1`,
        )
        .bind(
          input.actorUserId ?? null,
          input.actorRole ?? "admin",
          String(input.formId),
          `Menghapus formulir "${existing.name}" (${existing.slug})`,
          JSON.stringify({ slug: existing.slug }),
          nowMs,
        ),
    ]);

    if (Number(batchRes[0]?.meta?.changes ?? 0) !== 1) {
      const check = await tenantDb
        .prepare(
          `SELECT version, (SELECT COUNT(*) FROM leads WHERE form_id = tenant_forms.id) AS leads_count
           FROM tenant_forms WHERE id = ? LIMIT 1`,
        )
        .bind(input.formId)
        .first<{ readonly version: number; readonly leads_count: number }>();
      if (!check) throw new FormNotFoundError(input.formId);
      if (Number(check.leads_count) > 0) throw new FormHasLeadsError(input.formId);
      throw new FormStaleVersionError(input.formId, input.expectedVersion, Number(check.version));
    }

    return { deleted: true, formId: input.formId };
  } catch (err) {
    if (
      err instanceof FormNotFoundError ||
      err instanceof FormStaleVersionError ||
      err instanceof FormHasLeadsError ||
      err instanceof FormStorageError
    ) {
      throw err;
    }
    throw new FormStorageError("Gagal menghapus formulir.");
  }
}

/**
 * Reads the immutable `CustomFormLeadSnapshot` stored on a historical `leads` row.
 */
export async function getLeadFormSnapshotById(
  tenantDb: D1Database,
  leadId: number,
): Promise<{
  readonly leadId: number;
  readonly formId: number | null;
  readonly snapshot: CustomFormLeadSnapshot | null;
} | null> {
  const row = await tenantDb
    .prepare("SELECT id, form_id, form_snapshot_json FROM leads WHERE id = ? LIMIT 1")
    .bind(leadId)
    .first<{
      readonly id: number;
      readonly form_id: number | null;
      readonly form_snapshot_json: string | null;
    }>();

  if (!row) return null;
  const parsed = safeJsonParse(row.form_snapshot_json);
  const checked = parsed ? CustomFormLeadSnapshotSchema.safeParse(parsed) : null;
  return {
    leadId: Number(row.id),
    formId: row.form_id === null || row.form_id === undefined ? null : Number(row.form_id),
    snapshot: checked?.success ? checked.data : null,
  };
}
