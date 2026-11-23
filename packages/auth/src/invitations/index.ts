import {
  ALLOWED_EMAIL_SENDER,
  DEFAULT_EMAIL_SENDER_NAME,
  renderEmailTemplate,
  type EmailPort,
} from "@punyasitus/core/email/index";
import {
  buildPlatformAuditStatement,
  generatePlatformAuditId,
  type PlatformAuditRecord,
} from "@punyasitus/db/platform";
import { DEFAULT_REAUTH_WINDOW_MS, verifyUserPassword } from "../account.ts";
import { getSessionSecondFactorState } from "../platform/two-factor.ts";
import {
  mapMemberRoleToCanonicalRole,
  resolveAuthorizedTenantMember,
} from "../session-guard.ts";

/**
 * Tenant member invitations, 5-member seat cap, final-owner protection, and atomic
 * owner transfer (`packages/auth/src/invitations/index.ts`; TASK-026, REQ-035, REQ-034, REQ-065;
 * PLAN §4, §10, §11.2).
 *
 * Explicit configuration & hard invariants:
 * - Invitation expiry is explicitly configured to **48 hours** (`172_800` seconds; PLAN §10).
 * - Invitation tokens are cryptographically random (32 bytes), stored strictly as SHA-256 hashes
 *   in `PLATFORM_DB.verifications`, identity-bound to the exact normalized lowercase email,
 *   expiring, and single-use.
 * - **Hard 5-member cap (`MEMBER_LIMIT_REACHED`):** `active members + active unexpired pending
 *   invitations <= 5`, enforced atomically in SQL (`INSERT INTO invitations ... SELECT ... WHERE
 *   (SELECT COUNT(*) FROM members ...) + (SELECT COUNT(*) FROM invitations ...) < 5`) so concurrent
 *   `Promise.all` invites can NEVER exceed 5 seats.
 * - **Final-owner protection (`LAST_OWNER_PROTECTED`):** The last remaining `owner` can NEVER be
 *   removed or demoted, enforced atomically in SQL (`COUNT(*) > 1`) even under concurrent mutations.
 * - **Atomic owner transfer:** Requires recent reauthentication (password or 2FA within 10 minutes;
 *   returns `403 REAUTH_REQUIRED` if missing/stale), transfers `owner` role atomically under
 *   concurrent transfers, immediately shifts owner-only billing access, and appends a `platform_audit` entry.
 */

export const INVITATION_EXPIRY_HOURS = 48 as const;
export const INVITATION_EXPIRY_SECONDS = INVITATION_EXPIRY_HOURS * 60 * 60; // 172,800s (PLAN §10)
export const INVITATION_EXPIRY_MS = INVITATION_EXPIRY_SECONDS * 1000;
export const MAX_TENANT_MEMBERS = 5 as const;
export const OWNER_TRANSFER_REAUTH_WINDOW_MS = DEFAULT_REAUTH_WINDOW_MS; // 10 minutes (600,000ms)

const MAX_CUSTOM_INVITATION_EXPIRY_SECONDS = 14 * 24 * 60 * 60;
const SIMPLE_EMAIL_RE = /^[^\s@<>,;"'\\]+@[^\s@<>,;"'\\]+\.[^\s@<>,;"'\\]{2,}$/;

export type InvitableMemberRole = "admin" | "editor";
export type PersistedMemberRole = "owner" | "admin" | "editor" | "agency_staff" | "setup_staff";

export type InvitationErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "MEMBER_LIMIT_REACHED"
  | "ALREADY_MEMBER"
  | "INVITATION_ALREADY_PENDING"
  | "INVITATION_INVALID"
  | "INVITATION_EMAIL_MISMATCH"
  | "INVITATION_EXPIRED"
  | "INVITATION_ALREADY_USED"
  | "INVITATION_REVOKED"
  | "LAST_OWNER_PROTECTED"
  | "REAUTH_REQUIRED"
  | "OWNER_TRANSFER_CONFLICT"
  | "AUDIT_PERSISTENCE_FAILED";

export class InvitationError extends Error {
  readonly status: 401 | 403 | 404 | 409 | 422 | 500;
  readonly code: InvitationErrorCode;

  constructor(
    status: 401 | 403 | 404 | 409 | 422 | 500,
    code: InvitationErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "InvitationError";
    this.status = status;
    this.code = code;
  }
}

export interface TenantMemberItem {
  readonly memberId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly role: PersistedMemberRole;
  readonly createdAtMs: number;
}

export interface PendingInvitationItem {
  readonly invitationId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: string;
  readonly status: "pending" | "accepted" | "rejected" | "canceled" | "expired";
  readonly expiresAtMs: number;
  readonly inviterId: string;
  readonly createdAtMs: number;
}

export interface TenantMembershipSnapshot {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly handle: string;
  readonly tenantName: string;
  readonly agencyManaged: boolean;
  readonly members: readonly TenantMemberItem[];
  readonly pendingInvitations: readonly PendingInvitationItem[];
  readonly seatsUsed: number;
  readonly seatsLimit: number;
  readonly seatsRemaining: number;
  readonly invitationExpiryHours: number;
}

export interface CreateMemberInvitationInput {
  readonly organizationId: string;
  readonly tenantId: string;
  readonly tenantName?: string;
  readonly handle?: string;
  readonly inviterUserId: string;
  readonly inviterName?: string;
  readonly email: string;
  readonly role: InvitableMemberRole;
  readonly expiresInSeconds?: number;
  readonly emailPort?: EmailPort | null;
  readonly baseURL?: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface CreateMemberInvitationResult {
  readonly invitation: PendingInvitationItem;
  /** Raw single-use token returned to caller/email dispatcher; NEVER persisted in plaintext. */
  readonly token: string;
  readonly tokenHash: string;
  readonly expiresInSeconds: number;
  readonly emailDispatched: boolean;
  readonly audit: PlatformAuditRecord;
}

export interface AcceptMemberInvitationInput {
  readonly token: string;
  readonly acceptingUserId: string;
  /** Optional tenant handle binding (e.g. when accepted from `/dashboard/[handle]/settings/members/...`). */
  readonly expectedHandle?: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface AcceptMemberInvitationResult {
  readonly invitationId: string;
  readonly organizationId: string;
  readonly tenantId: string | null;
  readonly memberId: string;
  readonly userId: string;
  readonly email: string;
  readonly role: PersistedMemberRole;
  readonly audit: PlatformAuditRecord;
}

export interface RevokeMemberInvitationInput {
  readonly organizationId: string;
  readonly tenantId: string;
  readonly invitationId: string;
  readonly actorUserId: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface UpdateTenantMemberRoleInput {
  readonly organizationId: string;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly targetMemberId: string;
  readonly newRole: InvitableMemberRole;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface RemoveTenantMemberInput {
  readonly organizationId: string;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly targetMemberId: string;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface TransferTenantOwnershipInput {
  readonly organizationId: string;
  readonly tenantId: string;
  readonly tenantHandle?: string;
  readonly confirmTenantHandle?: string;
  readonly actorUserId: string;
  readonly actorSessionId?: string | null;
  readonly targetMemberId: string;
  readonly currentPassword?: string;
  readonly reauthenticatedAtMs?: number | null;
  readonly reauthWindowMs?: number;
  readonly requestId?: string | null;
  readonly nowMs?: number;
}

export interface TransferTenantOwnershipResult {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly previousOwnerUserId: string;
  readonly previousOwnerMemberId: string;
  readonly newOwnerUserId: string;
  readonly newOwnerMemberId: string;
  readonly reauthMethod: "password" | "second_factor" | "fresh_reauth";
  readonly audit: PlatformAuditRecord;
}

function generateSecureHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < buf.length; i += 1) {
    out += (buf[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

export async function hashInvitationToken(rawToken: string): Promise<string> {
  const bytes = new TextEncoder().encode(rawToken.trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i += 1) {
    out += (view[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

export function normalizeInviteEmail(rawEmail: string): string {
  const clean = rawEmail.trim().toLowerCase();
  if (!clean || clean.length > 254 || /[\r\n\0]/.test(clean) || !SIMPLE_EMAIL_RE.test(clean)) {
    throw new InvitationError(422, "VALIDATION_ERROR", "Format alamat email undangan tidak valid.");
  }
  return clean;
}

export function resolveInvitationExpirySeconds(overrideSeconds?: number): number {
  if (overrideSeconds === undefined) {
    return INVITATION_EXPIRY_SECONDS;
  }
  const rounded = Math.trunc(overrideSeconds);
  if (
    !Number.isFinite(rounded) ||
    rounded <= 0 ||
    rounded > MAX_CUSTOM_INVITATION_EXPIRY_SECONDS
  ) {
    throw new InvitationError(
      422,
      "VALIDATION_ERROR",
      `Masa berlaku undangan harus antara 1 detik hingga ${MAX_CUSTOM_INVITATION_EXPIRY_SECONDS} detik.`,
    );
  }
  return rounded;
}

function roleLabelId(role: string): string {
  switch (role) {
    case "owner":
      return "Pemilik Situs (Owner)";
    case "admin":
      return "Admin";
    case "editor":
      return "Editor";
    default:
      return role;
  }
}

interface MemberJoinedRow {
  readonly member_id: string;
  readonly user_id: string;
  readonly email: string;
  readonly name: string;
  readonly role: PersistedMemberRole;
  readonly created_at: number;
}

interface InvitationDbRow {
  readonly id: string;
  readonly organization_id: string;
  readonly email: string;
  readonly role: string;
  readonly status: "pending" | "accepted" | "rejected" | "canceled" | "expired";
  readonly expires_at: number;
  readonly inviter_id: string;
  readonly created_at: number;
}

/**
 * Lists active members and unexpired pending invitations for a tenant, including seat counts
 * against the hard 5-member cap (REQ-065).
 */
export async function listTenantMembersAndInvitations(
  platformDb: D1Database,
  params: {
    readonly tenantId: string;
    readonly nowMs?: number;
  },
): Promise<TenantMembershipSnapshot> {
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  const tenantRow = await platformDb
    .prepare(
      "SELECT id, organization_id, handle, name, agency_id FROM tenants WHERE id = ? LIMIT 1",
    )
    .bind(params.tenantId.trim())
    .first<{
      readonly id: string;
      readonly organization_id: string;
      readonly handle: string;
      readonly name: string;
      readonly agency_id: string | null;
    }>();

  if (!tenantRow) {
    throw new InvitationError(404, "NOT_FOUND", "Tenant tidak ditemukan.");
  }

  const [membersRes, invitesRes] = await Promise.all([
    platformDb
      .prepare(
        `SELECT
           m.id AS member_id,
           m.user_id AS user_id,
           u.email AS email,
           u.name AS name,
           m.role AS role,
           m.created_at AS created_at
         FROM members m
         INNER JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = ?
         ORDER BY (m.role = 'owner') DESC, m.created_at ASC, m.id ASC`,
      )
      .bind(tenantRow.organization_id)
      .all<MemberJoinedRow>(),
    platformDb
      .prepare(
        `SELECT id, organization_id, email, role, status, expires_at, inviter_id, created_at
         FROM invitations
         WHERE organization_id = ?
           AND status = 'pending'
           AND expires_at > ?
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(tenantRow.organization_id, nowMs)
      .all<InvitationDbRow>(),
  ]);

  const members: TenantMemberItem[] = (membersRes.results ?? []).map((row) => ({
    memberId: row.member_id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAtMs: row.created_at,
  }));

  const pendingInvitations: PendingInvitationItem[] = (invitesRes.results ?? []).map((row) => ({
    invitationId: row.id,
    organizationId: row.organization_id,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAtMs: row.expires_at,
    inviterId: row.inviter_id,
    createdAtMs: row.created_at,
  }));

  const seatsUsed = members.length + pendingInvitations.length;
  return {
    tenantId: tenantRow.id,
    organizationId: tenantRow.organization_id,
    handle: tenantRow.handle,
    tenantName: tenantRow.name,
    agencyManaged: tenantRow.agency_id !== null,
    members,
    pendingInvitations,
    seatsUsed,
    seatsLimit: MAX_TENANT_MEMBERS,
    seatsRemaining: Math.max(0, MAX_TENANT_MEMBERS - seatsUsed),
    invitationExpiryHours: INVITATION_EXPIRY_HOURS,
  };
}

/**
 * Creates a single-use, identity-bound, expiring (48h default) member invitation while
 * enforcing the hard 5-member seat cap (`active members + active pending invitations <= 5`)
 * atomically inside SQLite/D1 so concurrent `Promise.all` invites can never exceed 5.
 */
export async function createMemberInvitation(
  platformDb: D1Database,
  input: CreateMemberInvitationInput,
): Promise<CreateMemberInvitationResult> {
  const organizationId = input.organizationId.trim();
  const tenantId = input.tenantId.trim();
  const inviterUserId = input.inviterUserId.trim();
  if (!organizationId || !tenantId || !inviterUserId) {
    throw new InvitationError(
      422,
      "VALIDATION_ERROR",
      "organizationId, tenantId, dan inviterUserId wajib diisi.",
    );
  }
  if (input.role !== "admin" && input.role !== "editor") {
    throw new InvitationError(
      422,
      "VALIDATION_ERROR",
      'Peran undangan hanya boleh "admin" atau "editor".',
    );
  }

  const normalizedEmail = normalizeInviteEmail(input.email);
  const expiresInSeconds = resolveInvitationExpirySeconds(input.expiresInSeconds);
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const expiresAtMs = nowMs + expiresInSeconds * 1000;

  const invitationId = generatePlatformAuditId(nowMs);
  const rawToken = generateSecureHex(32);
  const tokenHash = await hashInvitationToken(rawToken);
  const verificationId = `invtok_${invitationId}`;

  // Atomic conditional insert enforcing:
  // 1. Not already an active member of this organization
  // 2. No active unexpired pending invitation for the same email
  // 3. Hard 5-seat cap across (members + active unexpired pending invitations)
  const insertInviteStmt = platformDb
    .prepare(
      `INSERT INTO invitations (
        id, organization_id, email, role, status, expires_at, inviter_id, created_at
      )
      SELECT ?, ?, ?, ?, 'pending', ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM members m
        INNER JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ? AND lower(u.email) = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM invitations i
        WHERE i.organization_id = ?
          AND lower(i.email) = ?
          AND i.status = 'pending'
          AND i.expires_at > ?
      )
      AND (
        (SELECT COUNT(*) FROM members WHERE organization_id = ?)
        +
        (SELECT COUNT(*) FROM invitations WHERE organization_id = ? AND status = 'pending' AND expires_at > ?)
      ) < ?`,
    )
    .bind(
      invitationId,
      organizationId,
      normalizedEmail,
      input.role,
      expiresAtMs,
      inviterUserId,
      nowMs,
      organizationId,
      normalizedEmail,
      organizationId,
      normalizedEmail,
      nowMs,
      organizationId,
      organizationId,
      nowMs,
      MAX_TENANT_MEMBERS,
    );

  const insertTokenStmt = platformDb
    .prepare(
      `INSERT INTO verifications (
        id, identifier, value, expires_at, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?
      WHERE changes() = 1`,
    )
    .bind(
      verificationId,
      `member-invite:${tokenHash}`,
      JSON.stringify({
        invitationId,
        organizationId,
        tenantId,
        email: normalizedEmail,
        role: input.role,
      }),
      expiresAtMs,
      nowMs,
      nowMs,
    );

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: inviterUserId,
      actorRole: "owner",
      action: "tenant.member.invite",
      targetType: "invitation",
      targetId: invitationId,
      tenantId,
      reason: `Invited ${input.role} member to tenant`,
      requireReason: false,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        role: input.role,
        expiresInSeconds,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch([insertInviteStmt, insertTokenStmt, auditStmt]);
  } catch (err) {
    throw new InvitationError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menyimpan undangan anggota secara atomik.",
      err,
    );
  }

  const inviteChanges = results[0]?.meta?.changes ?? 0;
  if (inviteChanges !== 1) {
    // Disambiguate why the atomic guard refused insertion
    const existingMember = await platformDb
      .prepare(
        `SELECT m.id FROM members m
         INNER JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = ? AND lower(u.email) = ?
         LIMIT 1`,
      )
      .bind(organizationId, normalizedEmail)
      .first<{ readonly id: string }>();
    if (existingMember) {
      throw new InvitationError(
        409,
        "ALREADY_MEMBER",
        "Pengguna dengan alamat email tersebut sudah menjadi anggota situs ini.",
      );
    }

    const existingPending = await platformDb
      .prepare(
        `SELECT id FROM invitations
         WHERE organization_id = ? AND lower(email) = ? AND status = 'pending' AND expires_at > ?
         LIMIT 1`,
      )
      .bind(organizationId, normalizedEmail, nowMs)
      .first<{ readonly id: string }>();
    if (existingPending) {
      throw new InvitationError(
        409,
        "INVITATION_ALREADY_PENDING",
        "Undangan aktif untuk alamat email tersebut masih menunggu konfirmasi.",
      );
    }

    throw new InvitationError(
      409,
      "MEMBER_LIMIT_REACHED",
      `Batas maksimal ${MAX_TENANT_MEMBERS} anggota (termasuk undangan aktif) telah tercapai.`,
    );
  }

  let emailDispatched = false;
  if (input.emailPort) {
    try {
      const base = (input.baseURL ?? "https://app.punyasitus.com").replace(/\/+$/, "");
      const handleSegment = input.handle
        ? `/dashboard/${encodeURIComponent(input.handle)}/settings/members/accept`
        : "/account";
      const acceptUrl = `${base}${handleSegment}?inviteToken=${encodeURIComponent(rawToken)}`;
      const rendered = renderEmailTemplate("member-invitation", {
        inviterName: input.inviterName?.trim() || "Pemilik Situs",
        organizationName: input.tenantName?.trim() || "Situs PunyaSitus",
        roleLabel: roleLabelId(input.role),
        acceptUrl,
        expiresInHours: Math.max(1, Math.round(expiresInSeconds / 3600)),
      });
      await input.emailPort.send({
        messageKey: `member-invite:${invitationId}`,
        template: "member-invitation",
        from: ALLOWED_EMAIL_SENDER,
        fromName: DEFAULT_EMAIL_SENDER_NAME,
        to: normalizedEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        oneShot: true,
      });
      emailDispatched = true;
    } catch {
      // Invitation is persisted; email delivery failure does not corrupt membership state.
      emailDispatched = false;
    }
  }

  return {
    invitation: {
      invitationId,
      organizationId,
      email: normalizedEmail,
      role: input.role,
      status: "pending",
      expiresAtMs,
      inviterId: inviterUserId,
      createdAtMs: nowMs,
    },
    token: rawToken,
    tokenHash,
    expiresInSeconds,
    emailDispatched,
    audit: auditEntry,
  };
}

/**
 * Accepts a single-use, identity-bound, expiring invitation token atomically.
 * - Wrong authenticated email returns `403 INVITATION_EMAIL_MISMATCH` without consuming the token.
 * - Expired invitation returns `409 INVITATION_EXPIRED`.
 * - Revoked/canceled invitation returns `409 INVITATION_REVOKED`.
 * - Replayed or concurrently accepted invitation returns `409 INVITATION_ALREADY_USED`.
 */
export async function acceptMemberInvitation(
  platformDb: D1Database,
  input: AcceptMemberInvitationInput,
): Promise<AcceptMemberInvitationResult> {
  const rawToken = input.token.trim();
  const acceptingUserId = input.acceptingUserId.trim();
  if (!acceptingUserId) {
    throw new InvitationError(401, "UNAUTHENTICATED", "Anda harus masuk untuk menerima undangan.");
  }
  if (rawToken.length < 16) {
    throw new InvitationError(404, "INVITATION_INVALID", "Token undangan tidak valid.");
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const tokenHash = await hashInvitationToken(rawToken);

  const [userRow, verificationRow] = await Promise.all([
    platformDb
      .prepare("SELECT id, email, name FROM users WHERE id = ? LIMIT 1")
      .bind(acceptingUserId)
      .first<{ readonly id: string; readonly email: string; readonly name: string }>(),
    platformDb
      .prepare("SELECT id, identifier, value, expires_at FROM verifications WHERE identifier = ? LIMIT 1")
      .bind(`member-invite:${tokenHash}`)
      .first<{
        readonly id: string;
        readonly identifier: string;
        readonly value: string;
        readonly expires_at: number;
      }>(),
  ]);

  if (!userRow) {
    throw new InvitationError(401, "UNAUTHENTICATED", "Akun pengguna tidak ditemukan.");
  }

  if (!verificationRow) {
    throw new InvitationError(
      409,
      "INVITATION_ALREADY_USED",
      "Undangan tidak valid, telah digunakan, atau sudah dibatalkan.",
    );
  }

  let parsedMeta: {
    readonly invitationId?: string;
    readonly organizationId?: string;
    readonly tenantId?: string;
    readonly email?: string;
  };
  try {
    parsedMeta = JSON.parse(verificationRow.value) as typeof parsedMeta;
  } catch {
    throw new InvitationError(404, "INVITATION_INVALID", "Metadata undangan rusak.");
  }

  if (!parsedMeta.invitationId || !parsedMeta.organizationId) {
    throw new InvitationError(404, "INVITATION_INVALID", "Metadata undangan tidak lengkap.");
  }

  const inviteRow = await platformDb
    .prepare(
      `SELECT id, organization_id, email, role, status, expires_at, inviter_id, created_at
       FROM invitations
       WHERE id = ? AND organization_id = ?
       LIMIT 1`,
    )
    .bind(parsedMeta.invitationId, parsedMeta.organizationId)
    .first<InvitationDbRow>();

  if (!inviteRow) {
    throw new InvitationError(404, "INVITATION_INVALID", "Undangan tidak ditemukan.");
  }

  // Identity binding check BEFORE any state mutation (403 on wrong email, token stays intact!)
  const userEmailNormalized = userRow.email.trim().toLowerCase();
  const invitedEmailNormalized = inviteRow.email.trim().toLowerCase();
  if (userEmailNormalized !== invitedEmailNormalized) {
    throw new InvitationError(
      403,
      "INVITATION_EMAIL_MISMATCH",
      "Undangan ini terikat pada alamat email yang berbeda dan tidak dapat diterima oleh akun Anda.",
    );
  }

  if (inviteRow.status === "accepted") {
    throw new InvitationError(409, "INVITATION_ALREADY_USED", "Undangan ini sudah pernah digunakan.");
  }
  if (inviteRow.status === "canceled" || inviteRow.status === "rejected") {
    throw new InvitationError(409, "INVITATION_REVOKED", "Undangan ini telah dibatalkan.");
  }
  if (inviteRow.status === "expired" || inviteRow.expires_at <= nowMs) {
    await platformDb.batch([
      platformDb
        .prepare("UPDATE invitations SET status = 'expired' WHERE id = ? AND status = 'pending'")
        .bind(inviteRow.id),
      platformDb.prepare("DELETE FROM verifications WHERE id = ?").bind(verificationRow.id),
    ]);
    throw new InvitationError(
      409,
      "INVITATION_EXPIRED",
      `Undangan ini telah kedaluwarsa (masa berlaku ${INVITATION_EXPIRY_HOURS} jam).`,
    );
  }

  const tenantRow = await platformDb
    .prepare("SELECT id, handle FROM tenants WHERE organization_id = ? LIMIT 1")
    .bind(inviteRow.organization_id)
    .first<{ readonly id: string; readonly handle: string }>();
  const resolvedTenantId = parsedMeta.tenantId ?? tenantRow?.id ?? null;

  if (
    input.expectedHandle !== undefined &&
    tenantRow &&
    tenantRow.handle.trim().toLowerCase() !== input.expectedHandle.trim().toLowerCase()
  ) {
    throw new InvitationError(
      404,
      "INVITATION_INVALID",
      "Undangan tidak cocok dengan situs yang diminta.",
    );
  }

  const memberId = generatePlatformAuditId(nowMs);
  const memberRole = inviteRow.role as PersistedMemberRole;

  const consumeInviteStmt = platformDb
    .prepare(
      `UPDATE invitations
       SET status = 'accepted'
       WHERE id = ?
         AND organization_id = ?
         AND status = 'pending'
         AND expires_at > ?
         AND lower(email) = ?
         AND NOT EXISTS (
           SELECT 1 FROM members WHERE organization_id = ? AND user_id = ?
         )
         AND (SELECT COUNT(*) FROM members WHERE organization_id = ?) < ?`,
    )
    .bind(
      inviteRow.id,
      inviteRow.organization_id,
      nowMs,
      userEmailNormalized,
      inviteRow.organization_id,
      acceptingUserId,
      inviteRow.organization_id,
      MAX_TENANT_MEMBERS,
    );

  const insertMemberStmt = platformDb
    .prepare(
      `INSERT INTO members (id, organization_id, user_id, role, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE changes() = 1`,
    )
    .bind(memberId, inviteRow.organization_id, acceptingUserId, memberRole, nowMs);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: acceptingUserId,
      actorRole: memberRole,
      action: "tenant.member.invite_accept",
      targetType: "invitation",
      targetId: inviteRow.id,
      tenantId: resolvedTenantId,
      reason: `Accepted ${memberRole} invitation`,
      requireReason: false,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        memberId,
        role: memberRole,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  // Clean up verification token hash once our member insert succeeded
  const deleteTokenStmt = platformDb
    .prepare(
      `DELETE FROM verifications
       WHERE id = ?
         AND EXISTS (SELECT 1 FROM members WHERE id = ?)`,
    )
    .bind(verificationRow.id, memberId);

  let results: D1Result[];
  try {
    results = await platformDb.batch([
      consumeInviteStmt,
      insertMemberStmt,
      auditStmt,
      deleteTokenStmt,
    ]);
  } catch (err) {
    throw new InvitationError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menyelesaikan penerimaan undangan secara atomik.",
      err,
    );
  }

  const consumeChanges = results[0]?.meta?.changes ?? 0;
  const memberChanges = results[1]?.meta?.changes ?? 0;

  if (consumeChanges !== 1 || memberChanges !== 1) {
    const existingMember = await platformDb
      .prepare("SELECT id FROM members WHERE organization_id = ? AND user_id = ? LIMIT 1")
      .bind(inviteRow.organization_id, acceptingUserId)
      .first<{ readonly id: string }>();
    if (existingMember) {
      throw new InvitationError(
        409,
        "ALREADY_MEMBER",
        "Akun Anda sudah menjadi anggota aktif situs ini.",
      );
    }

    const latestInvite = await platformDb
      .prepare("SELECT status, expires_at FROM invitations WHERE id = ? LIMIT 1")
      .bind(inviteRow.id)
      .first<{ readonly status: string; readonly expires_at: number }>();
    if (latestInvite?.status === "accepted") {
      throw new InvitationError(
        409,
        "INVITATION_ALREADY_USED",
        "Undangan ini sudah digunakan.",
      );
    }
    if (latestInvite?.status === "canceled" || latestInvite?.status === "rejected") {
      throw new InvitationError(409, "INVITATION_REVOKED", "Undangan ini telah dibatalkan.");
    }
    if (!latestInvite || latestInvite.expires_at <= nowMs || latestInvite.status === "expired") {
      throw new InvitationError(409, "INVITATION_EXPIRED", "Undangan ini telah kedaluwarsa.");
    }

    throw new InvitationError(
      409,
      "MEMBER_LIMIT_REACHED",
      `Batas maksimal ${MAX_TENANT_MEMBERS} anggota untuk situs ini telah tercapai.`,
    );
  }

  return {
    invitationId: inviteRow.id,
    organizationId: inviteRow.organization_id,
    tenantId: resolvedTenantId,
    memberId,
    userId: acceptingUserId,
    email: userEmailNormalized,
    role: memberRole,
    audit: auditEntry,
  };
}

/**
 * Revokes (cancels) a pending invitation atomically, deleting its hashed verification token
 * and immediately freeing the seat in the 5-member cap.
 */
export async function revokeMemberInvitation(
  platformDb: D1Database,
  input: RevokeMemberInvitationInput,
): Promise<{ readonly invitationId: string; readonly audit: PlatformAuditRecord }> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const invitationId = input.invitationId.trim();
  const organizationId = input.organizationId.trim();
  if (!invitationId || !organizationId) {
    throw new InvitationError(422, "VALIDATION_ERROR", "invitationId dan organizationId wajib diisi.");
  }

  const cancelStmt = platformDb
    .prepare(
      `UPDATE invitations
       SET status = 'canceled'
       WHERE id = ? AND organization_id = ? AND status = 'pending'`,
    )
    .bind(invitationId, organizationId);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "owner",
      action: "tenant.member.invite_revoke",
      targetType: "invitation",
      targetId: invitationId,
      tenantId: input.tenantId,
      reason: "Revoked pending member invitation",
      requireReason: false,
      outcome: "success",
      requestId: input.requestId ?? null,
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  // Strictly gate token deletion on the canceled invitation belonging to THIS organization
  // so a caller from Tenant A can never destroy Tenant B's pending verification token.
  const deleteTokenStmt = platformDb
    .prepare(
      `DELETE FROM verifications
       WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM invitations
           WHERE id = ? AND organization_id = ? AND status = 'canceled'
         )`,
    )
    .bind(`invtok_${invitationId}`, invitationId, organizationId);

  let results: D1Result[];
  try {
    results = await platformDb.batch([cancelStmt, auditStmt, deleteTokenStmt]);
  } catch (err) {
    throw new InvitationError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal membatalkan undangan secara atomik.",
      err,
    );
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    throw new InvitationError(
      404,
      "NOT_FOUND",
      "Undangan tertunda tidak ditemukan atau sudah tidak aktif.",
    );
  }

  return { invitationId, audit: auditEntry };
}

/**
 * Updates a non-owner member's role (`admin` | `editor`).
 * Atomically enforces `LAST_OWNER_PROTECTED` so the final owner can never be demoted,
 * including under concurrent requests.
 */
export async function updateTenantMemberRole(
  platformDb: D1Database,
  input: UpdateTenantMemberRoleInput,
): Promise<{ readonly memberId: string; readonly role: InvitableMemberRole; readonly audit: PlatformAuditRecord }> {
  if (input.newRole !== "admin" && input.newRole !== "editor") {
    throw new InvitationError(
      422,
      "VALIDATION_ERROR",
      'Peran anggota yang dapat diubah melalui menu ini hanya "admin" atau "editor".',
    );
  }

  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const organizationId = input.organizationId.trim();
  const targetMemberId = input.targetMemberId.trim();

  const updateStmt = platformDb
    .prepare(
      `UPDATE members
       SET role = ?
       WHERE id = ?
         AND organization_id = ?
         AND (
           role != 'owner'
           OR (SELECT COUNT(*) FROM members WHERE organization_id = ? AND role = 'owner') > 1
         )`,
    )
    .bind(input.newRole, targetMemberId, organizationId, organizationId);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "owner",
      action: "tenant.member.update_role",
      targetType: "member",
      targetId: targetMemberId,
      tenantId: input.tenantId,
      reason: `Updated member role to ${input.newRole}`,
      requireReason: false,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: { newRole: input.newRole },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch([updateStmt, auditStmt]);
  } catch (err) {
    throw new InvitationError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal memperbarui peran anggota secara atomik.",
      err,
    );
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    const existing = await platformDb
      .prepare("SELECT id, role FROM members WHERE id = ? AND organization_id = ? LIMIT 1")
      .bind(targetMemberId, organizationId)
      .first<{ readonly id: string; readonly role: PersistedMemberRole }>();
    if (!existing) {
      throw new InvitationError(404, "NOT_FOUND", "Anggota tidak ditemukan pada situs ini.");
    }
    if (existing.role === "owner") {
      throw new InvitationError(
        409,
        "LAST_OWNER_PROTECTED",
        "Pemilik terakhir situs tidak dapat diturunkan perannya. Lakukan alih kepemilikan terlebih dahulu.",
      );
    }
    throw new InvitationError(404, "NOT_FOUND", "Anggota tidak dapat diperbarui.");
  }

  return { memberId: targetMemberId, role: input.newRole, audit: auditEntry };
}

/**
 * Removes a member from a tenant organization immediately.
 * Atomically enforces `LAST_OWNER_PROTECTED` (`COUNT(owners) > 1`) even under concurrent removals.
 */
export async function removeTenantMember(
  platformDb: D1Database,
  input: RemoveTenantMemberInput,
): Promise<{
  readonly removedMemberId: string;
  readonly removedUserId: string;
  readonly audit: PlatformAuditRecord;
}> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const organizationId = input.organizationId.trim();
  const targetMemberId = input.targetMemberId.trim();

  const existingBefore = await platformDb
    .prepare("SELECT id, user_id, role FROM members WHERE id = ? AND organization_id = ? LIMIT 1")
    .bind(targetMemberId, organizationId)
    .first<{ readonly id: string; readonly user_id: string; readonly role: PersistedMemberRole }>();

  if (!existingBefore) {
    throw new InvitationError(404, "NOT_FOUND", "Anggota tidak ditemukan pada situs ini.");
  }

  const deleteStmt = platformDb
    .prepare(
      `DELETE FROM members
       WHERE id = ?
         AND organization_id = ?
         AND (
           role != 'owner'
           OR (SELECT COUNT(*) FROM members WHERE organization_id = ? AND role = 'owner') > 1
         )`,
    )
    .bind(targetMemberId, organizationId, organizationId);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId: input.actorUserId,
      actorRole: "owner",
      action: "tenant.member.remove",
      targetType: "member",
      targetId: targetMemberId,
      tenantId: input.tenantId,
      reason: "Removed tenant member",
      requireReason: false,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        removedUserId: existingBefore.user_id,
        removedRole: existingBefore.role,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch([deleteStmt, auditStmt]);
  } catch (err) {
    throw new InvitationError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Gagal menghapus anggota secara atomik.",
      err,
    );
  }

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    const stillExists = await platformDb
      .prepare("SELECT id, role FROM members WHERE id = ? AND organization_id = ? LIMIT 1")
      .bind(targetMemberId, organizationId)
      .first<{ readonly id: string; readonly role: PersistedMemberRole }>();
    if (!stillExists) {
      throw new InvitationError(404, "NOT_FOUND", "Anggota sudah dihapus sebelumnya.");
    }
    if (stillExists.role === "owner") {
      throw new InvitationError(
        409,
        "LAST_OWNER_PROTECTED",
        "Pemilik terakhir situs tidak dapat dihapus. Lakukan alih kepemilikan terlebih dahulu.",
      );
    }
    throw new InvitationError(409, "LAST_OWNER_PROTECTED", "Anggota tidak dapat dihapus.");
  }

  return {
    removedMemberId: targetMemberId,
    removedUserId: existingBefore.user_id,
    audit: auditEntry,
  };
}

async function verifyOwnerTransferReauthentication(
  platformDb: D1Database,
  params: {
    readonly actorUserId: string;
    readonly actorSessionId?: string | null;
    readonly currentPassword?: string;
    readonly reauthenticatedAtMs?: number | null;
    readonly reauthWindowMs?: number;
    readonly nowMs: number;
  },
): Promise<"password" | "second_factor" | "fresh_reauth"> {
  const windowMs = Math.max(1_000, Math.trunc(params.reauthWindowMs ?? OWNER_TRANSFER_REAUTH_WINDOW_MS));

  // 1. Explicit password proof
  if (typeof params.currentPassword === "string" && params.currentPassword.length > 0) {
    const ok = await verifyUserPassword(platformDb, params.actorUserId, params.currentPassword);
    if (!ok) {
      throw new InvitationError(
        403,
        "REAUTH_REQUIRED",
        "Kata sandi konfirmasi tidak sesuai. Masukkan kata sandi akun Anda saat ini.",
      );
    }
    return "password";
  }

  // 2. Recent 2FA session verification within 10 minutes
  if (params.actorSessionId) {
    const state = await getSessionSecondFactorState(platformDb, {
      sessionId: params.actorSessionId,
      userId: params.actorUserId,
    });
    if (state.sessionVerified && state.verifiedAtMs !== null) {
      const ageMs = params.nowMs - state.verifiedAtMs;
      if (ageMs >= 0 && ageMs <= windowMs) {
        return "second_factor";
      }
    }
  }

  // 3. Explicit fresh step-up timestamp within 10 minutes
  if (
    typeof params.reauthenticatedAtMs === "number" &&
    Number.isFinite(params.reauthenticatedAtMs)
  ) {
    const ageMs = params.nowMs - params.reauthenticatedAtMs;
    if (ageMs >= 0 && ageMs <= windowMs) {
      return "fresh_reauth";
    }
  }

  throw new InvitationError(
    403,
    "REAUTH_REQUIRED",
    "Autentikasi ulang (kata sandi saat ini atau verifikasi 2FA dalam 10 menit terakhir) diperlukan untuk mengalihkan kepemilikan situs.",
  );
}

/**
 * Atomically transfers `owner` role from the current owner to an existing active member
 * of the same tenant organization (PLAN §4; TASK-026).
 *
 * Guarantees:
 * - Requires recent reauthentication (`403 REAUTH_REQUIRED` if missing or stale > 10 minutes).
 * - Atomic under concurrent transfers (`Promise.all([transfer(A), transfer(B)])`): at most one
 *   succeeds, never leaving 0 owners or two conflicting transfers.
 * - Immediately moves owner-only billing access (`billing:read`/`billing:pay`) from old owner
 *   (demoted to `admin`) to new owner (`owner`).
 * - Appends a `platform_audit` record in the same D1 batch; audit failure rolls back transfer.
 */
export async function transferTenantOwnership(
  platformDb: D1Database,
  input: TransferTenantOwnershipInput,
): Promise<TransferTenantOwnershipResult> {
  const nowMs = Math.trunc(input.nowMs ?? Date.now());
  const organizationId = input.organizationId.trim();
  const tenantId = input.tenantId.trim();
  const actorUserId = input.actorUserId.trim();
  const targetMemberId = input.targetMemberId.trim();

  if (!organizationId || !tenantId || !actorUserId || !targetMemberId) {
    throw new InvitationError(
      422,
      "VALIDATION_ERROR",
      "organizationId, tenantId, actorUserId, dan targetMemberId wajib diisi.",
    );
  }

  if (
    input.confirmTenantHandle !== undefined &&
    input.tenantHandle !== undefined &&
    input.confirmTenantHandle.trim().toLowerCase() !== input.tenantHandle.trim().toLowerCase()
  ) {
    throw new InvitationError(
      422,
      "VALIDATION_ERROR",
      "Konfirmasi handle situs tidak cocok.",
    );
  }

  // 1. Enforce recent reauthentication FIRST (before mutating anything)
  const reauthMethod = await verifyOwnerTransferReauthentication(platformDb, {
    actorUserId,
    actorSessionId: input.actorSessionId,
    currentPassword: input.currentPassword,
    reauthenticatedAtMs: input.reauthenticatedAtMs,
    reauthWindowMs: input.reauthWindowMs,
    nowMs,
  });

  // 2. Verify live actor owner row & target member row inside the same organization
  const [actorMember, targetMember] = await Promise.all([
    platformDb
      .prepare("SELECT id, user_id, role FROM members WHERE organization_id = ? AND user_id = ? LIMIT 1")
      .bind(organizationId, actorUserId)
      .first<{ readonly id: string; readonly user_id: string; readonly role: PersistedMemberRole }>(),
    platformDb
      .prepare("SELECT id, user_id, role FROM members WHERE id = ? AND organization_id = ? LIMIT 1")
      .bind(targetMemberId, organizationId)
      .first<{ readonly id: string; readonly user_id: string; readonly role: PersistedMemberRole }>(),
  ]);

  if (!actorMember || actorMember.role !== "owner") {
    throw new InvitationError(
      403,
      "FORBIDDEN",
      "Hanya pemilik situs (Owner) aktif yang dapat mengalihkan kepemilikan.",
    );
  }
  if (!targetMember) {
    throw new InvitationError(
      404,
      "NOT_FOUND",
      "Anggota tujuan tidak ditemukan pada situs ini.",
    );
  }
  if (targetMember.user_id === actorUserId || targetMember.role === "owner") {
    throw new InvitationError(
      422,
      "VALIDATION_ERROR",
      "Pilih anggota aktif lain (Admin atau Editor) sebagai penerima kepemilikan baru.",
    );
  }
  if (targetMember.role !== "admin" && targetMember.role !== "editor") {
    throw new InvitationError(
      422,
      "VALIDATION_ERROR",
      "Kepemilikan hanya dapat dialihkan ke anggota tetap (Admin atau Editor) pada situs ini.",
    );
  }

  // 3. Single atomic D1 batch:
  //    (a) Demote current owner -> 'admin' ONLY IF still 'owner' AND target is still non-owner in org
  //    (b) Promote target -> 'owner' ONLY IF (a) changed 1 row
  //    (c) Bump tenant version ONLY IF (b) changed 1 row
  //    (d) Write platform_audit ONLY IF (c) changed 1 row
  const demoteActorStmt = platformDb
    .prepare(
      `UPDATE members
       SET role = 'admin'
       WHERE id = ?
         AND organization_id = ?
         AND user_id = ?
         AND role = 'owner'
         AND EXISTS (
           SELECT 1 FROM members
           WHERE id = ?
             AND organization_id = ?
             AND user_id != ?
             AND role IN ('admin', 'editor')
         )`,
    )
    .bind(
      actorMember.id,
      organizationId,
      actorUserId,
      targetMember.id,
      organizationId,
      actorUserId,
    );

  const promoteTargetStmt = platformDb
    .prepare(
      `UPDATE members
       SET role = 'owner'
       WHERE id = ?
         AND organization_id = ?
         AND changes() = 1`,
    )
    .bind(targetMember.id, organizationId);

  const bumpTenantStmt = platformDb
    .prepare(
      `UPDATE tenants
       SET version = version + 1, updated_at = ?
       WHERE id = ?
         AND changes() = 1`,
    )
    .bind(nowMs, tenantId);

  const { statement: auditStmt, entry: auditEntry } = buildPlatformAuditStatement(
    platformDb,
    {
      actorUserId,
      actorRole: "owner",
      action: "tenant.owner.transfer",
      targetType: "tenant",
      targetId: tenantId,
      tenantId,
      reason: "Transferred tenant ownership to existing member",
      requireReason: false,
      outcome: "success",
      requestId: input.requestId ?? null,
      metadata: {
        previousOwnerUserId: actorUserId,
        previousOwnerMemberId: actorMember.id,
        newOwnerUserId: targetMember.user_id,
        newOwnerMemberId: targetMember.id,
        reauthMethod,
      },
      createdAtMs: nowMs,
    },
    { onlyIfPreviousChanged: true },
  );

  let results: D1Result[];
  try {
    results = await platformDb.batch([
      demoteActorStmt,
      promoteTargetStmt,
      bumpTenantStmt,
      auditStmt,
    ]);
  } catch (err) {
    throw new InvitationError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Alih kepemilikan dibatalkan karena gagal menyelesaikan transaksi atomik atau audit.",
      err,
    );
  }

  const demoteChanges = results[0]?.meta?.changes ?? 0;
  const promoteChanges = results[1]?.meta?.changes ?? 0;
  const auditChanges = results[3]?.meta?.changes ?? 0;

  if (demoteChanges !== 1 || promoteChanges !== 1) {
    throw new InvitationError(
      409,
      "OWNER_TRANSFER_CONFLICT",
      "Alih kepemilikan gagal karena status kepemilikan berubah secara bersamaan.",
    );
  }

  if (auditChanges !== 1) {
    throw new InvitationError(
      500,
      "AUDIT_PERSISTENCE_FAILED",
      "Catatan audit alih kepemilikan tidak berhasil tersimpan.",
    );
  }

  return {
    tenantId,
    organizationId,
    previousOwnerUserId: actorUserId,
    previousOwnerMemberId: actorMember.id,
    newOwnerUserId: targetMember.user_id,
    newOwnerMemberId: targetMember.id,
    reauthMethod,
    audit: auditEntry,
  };
}

/**
 * Verifies live owner-only billing access for a tenant (`billing:read` / `billing:pay`),
 * honoring PLAN §17.2 (agency-managed client tenants never expose billing to client users).
 */
export async function assertTenantOwnerBillingAccess(
  platformDb: D1Database,
  params: {
    readonly userId: string;
    readonly handle?: string;
    readonly tenantId?: string;
    readonly action?: "billing:read" | "billing:pay" | "billing:recheck" | "billing:receipts";
    readonly nowMs?: number;
  },
): Promise<{
  readonly tenantId: string;
  readonly organizationId: string;
  readonly handle: string;
  readonly role: ReturnType<typeof mapMemberRoleToCanonicalRole>;
}> {
  const member = await resolveAuthorizedTenantMember(platformDb, {
    userId: params.userId,
    handle: params.handle,
    tenantId: params.tenantId,
    requiredPermission: params.action ?? "billing:read",
    surface: "app",
    nowMs: params.nowMs,
  });

  // PLAN §17.2: For agency-managed tenants, client tenant members have zero billing access.
  const tenantRow = await platformDb
    .prepare("SELECT agency_id FROM tenants WHERE id = ? LIMIT 1")
    .bind(member.tenantId)
    .first<{ readonly agency_id: string | null }>();

  if (tenantRow?.agency_id && member.dbRole !== "agency_staff") {
    throw new InvitationError(
      403,
      "FORBIDDEN",
      "Tagihan situs ini dikelola langsung oleh agensi Anda.",
    );
  }

  return {
    tenantId: member.tenantId,
    organizationId: member.organizationId,
    handle: member.handle,
    role: member.role,
  };
}
