import type {
  WorkspaceInviteLinkData,
  WorkspaceInvitePreview,
  WorkspaceMemberData,
  WorkspaceMembersErrorCode,
} from "@dx/api";
import type { Principal, WorkspaceRole } from "@dx/domain";
import { Effect } from "effect";
import { encodeBase64Url } from "../../encoding/base64.js";
import type { Bindings } from "../../http/types.js";
import { settingsAuditLogger } from "../../logging.js";
import {
  type ConfigValueEnvelope,
  decryptConfigValue,
  encryptConfigValue,
  loadConfigEncryptionKeyring,
} from "../config-encryption.js";

export class WorkspaceMembersError extends Error {
  constructor(
    readonly code: WorkspaceMembersErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 503,
    message: string,
    readonly details: {
      readonly fieldErrors?: ReadonlyArray<{
        readonly field: string;
        readonly message: string;
      }>;
      readonly workspace?: {
        readonly displayName: string;
        readonly shortName: string;
      };
    } = {},
  ) {
    super(message);
  }
}

const adminRequired = () =>
  new WorkspaceMembersError(
    "WORKSPACE_ADMIN_REQUIRED",
    403,
    "Only workspace admins can do this.",
  );

export interface WorkspaceAccess {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly shortName: string;
  readonly role: WorkspaceRole;
  readonly userId: string;
}

const isAdmin = (role: WorkspaceRole) => role === "owner" || role === "admin";

/** Resolves the caller's active membership in the workspace named by `slug`. */
export const workspaceAccess = async (
  db: D1Database,
  principal: Principal,
  slug: string,
): Promise<WorkspaceAccess> => {
  if (!principal.credentialScopes?.includes("workspace"))
    throw new WorkspaceMembersError(
      "SETTINGS_SCOPE_FORBIDDEN",
      403,
      "The settings scope is unavailable for this user.",
    );
  const row = await db
    .prepare(
      `SELECT organization.id AS workspace_id, organization.name AS display_name,
              organization.slug AS short_name, member.role
         FROM member
         JOIN organization ON organization.id = member.organizationId
        WHERE member.userId = ? AND organization.slug = ? COLLATE NOCASE
          AND organization.lifecycleState = 'active'`,
    )
    .bind(principal.userId, slug)
    .first<{
      workspace_id: string;
      display_name: string;
      short_name: string;
      role: WorkspaceRole;
    }>();
  if (row === null)
    throw new WorkspaceMembersError(
      "SETTINGS_SCOPE_FORBIDDEN",
      403,
      "The settings scope is unavailable for this user.",
    );
  return {
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    shortName: row.short_name,
    role: row.role,
    userId: principal.userId,
  };
};

export const requireAdmin = (access: WorkspaceAccess) => {
  if (!isAdmin(access.role)) throw adminRequired();
};

// Better Auth stores dates as epoch milliseconds or ISO strings depending on
// the writer; normalize both.
const isoFrom = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const latest = (...values: ReadonlyArray<string | undefined>) =>
  values
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);

interface MemberRow {
  readonly user_id: string;
  readonly email: string;
  readonly name: string;
  readonly role: "owner" | "admin" | "member";
  readonly joined_at: unknown;
  readonly session_at: unknown;
  readonly thread_at: string | null;
}

const memberSelect = `
  SELECT member.userId AS user_id, "user".email, "user".name, member.role,
         member.createdAt AS joined_at,
         (SELECT MAX(session.updatedAt) FROM session
           WHERE session.userId = member.userId) AS session_at,
         (SELECT MAX(threads.last_activity_at) FROM threads
           WHERE threads.owner_user_id = member.userId) AS thread_at
    FROM member
    JOIN "user" ON "user".id = member.userId`;

const memberData = (row: MemberRow): WorkspaceMemberData => {
  const lastActiveAt = latest(
    isoFrom(row.session_at),
    isoFrom(row.thread_at ?? undefined),
  );
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    joinedAt: isoFrom(row.joined_at) ?? new Date(0).toISOString(),
    ...(lastActiveAt === undefined ? {} : { lastActiveAt }),
  };
};

const roleOrder = { owner: 0, admin: 1, member: 2 } as const;

export const listMembers = async (
  db: D1Database,
  access: WorkspaceAccess,
): Promise<ReadonlyArray<WorkspaceMemberData>> => {
  const result = await db
    .prepare(`${memberSelect} WHERE member.organizationId = ?`)
    .bind(access.workspaceId)
    .all<MemberRow>();
  return result.results
    .map(memberData)
    .sort(
      (left, right) =>
        roleOrder[left.role] - roleOrder[right.role] ||
        left.email.localeCompare(right.email),
    );
};

const findMember = async (
  db: D1Database,
  workspaceId: string,
  userId: string,
) =>
  db
    .prepare(
      `${memberSelect} WHERE member.organizationId = ? AND member.userId = ?`,
    )
    .bind(workspaceId, userId)
    .first<MemberRow>();

const memberNotFound = () =>
  new WorkspaceMembersError(
    "WORKSPACE_MEMBER_NOT_FOUND",
    404,
    "Workspace member not found.",
  );

const ownerImmutable = () =>
  new WorkspaceMembersError(
    "WORKSPACE_OWNER_IMMUTABLE",
    409,
    "The workspace owner cannot be changed or removed.",
  );

export const setMemberRole = async (
  db: D1Database,
  access: WorkspaceAccess,
  targetUserId: string,
  role: "admin" | "member",
): Promise<WorkspaceMemberData> => {
  requireAdmin(access);
  const target = await findMember(db, access.workspaceId, targetUserId);
  if (target === null) throw memberNotFound();
  if (target.role === "owner") throw ownerImmutable();
  if (target.role !== role) {
    await db
      .prepare(
        "UPDATE member SET role = ? WHERE organizationId = ? AND userId = ? AND role != 'owner'",
      )
      .bind(role, access.workspaceId, targetUserId)
      .run();
    settingsAuditLogger.info("Workspace member role changed.", {
      event: "workspace_member_role_changed",
      workspaceId: access.workspaceId,
      userId: access.userId,
      targetUserId,
      previousRole: target.role,
      role,
    });
  }
  return memberData({ ...target, role });
};

const deleteMembership = async (
  db: D1Database,
  workspaceId: string,
  userId: string,
) => {
  const result = await db
    .prepare(
      "DELETE FROM member WHERE organizationId = ? AND userId = ? AND role != 'owner' RETURNING userId",
    )
    .bind(workspaceId, userId)
    .all();
  return result.results.length === 1;
};

/**
 * The user's Threads in this workspace whose execution workspace may be
 * running. Leaving or removal releases them (drain dxd, then pause) so open
 * terminals and the resident daemon stop with membership.
 */
const runningWorkspaceThreads = async (
  db: D1Database,
  workspaceId: string,
  userId: string,
): Promise<ReadonlyArray<string>> =>
  (
    await db
      .prepare(
        `SELECT threads.id
           FROM threads
           JOIN projects ON projects.id = threads.project_id
           JOIN execution_workspace ON execution_workspace.thread_id = threads.id
          WHERE threads.owner_user_id = ? AND projects.workspace_id = ?
            AND threads.lifecycle_state = 'active'
            AND execution_workspace.state IN ('provisioning', 'initialized')
          LIMIT 200`,
      )
      .bind(userId, workspaceId)
      .all<{ id: string }>()
  ).results.map(({ id }) => id);

/**
 * Removes a member. Their workspace Threads stay stored and attributed to
 * them; Thread access requires membership, so the Threads come back if they
 * rejoin the same workspace.
 */
export const removeMember = async (
  db: D1Database,
  access: WorkspaceAccess,
  targetUserId: string,
) => {
  requireAdmin(access);
  if (targetUserId === access.userId)
    throw new WorkspaceMembersError(
      "INVALID_WORKSPACE_MEMBERS_REQUEST",
      400,
      "Use Leave Workspace to remove yourself.",
    );
  const target = await findMember(db, access.workspaceId, targetUserId);
  if (target === null) throw memberNotFound();
  if (target.role === "owner") throw ownerImmutable();
  if (!(await deleteMembership(db, access.workspaceId, targetUserId)))
    throw memberNotFound();
  settingsAuditLogger.info("Workspace member removed.", {
    event: "workspace_member_removed",
    workspaceId: access.workspaceId,
    userId: access.userId,
    targetUserId,
  });
  return runningWorkspaceThreads(db, access.workspaceId, targetUserId);
};

export const leaveWorkspace = async (
  db: D1Database,
  access: WorkspaceAccess,
) => {
  if (access.role === "owner") throw ownerImmutable();
  if (!(await deleteMembership(db, access.workspaceId, access.userId)))
    throw memberNotFound();
  settingsAuditLogger.info("Workspace member left.", {
    event: "workspace_member_left",
    workspaceId: access.workspaceId,
    userId: access.userId,
  });
  return runningWorkspaceThreads(db, access.workspaceId, access.userId);
};

// Invite links ----------------------------------------------------------------

const encoder = new TextEncoder();

const sha256Hex = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const inviteUrl = (origin: string, token: string) =>
  `${origin}/join/${token}`;

const envelopeContext = (linkId: string, workspaceId: string) => ({
  purpose: "workspace-invite-link",
  linkId,
  workspaceId,
});

const keyringFor = (bindings: Bindings) =>
  Effect.runPromise(loadConfigEncryptionKeyring(bindings)).catch(() => {
    throw new WorkspaceMembersError(
      "PERSISTENCE_UNAVAILABLE",
      503,
      "Workspace invite links are temporarily unavailable.",
    );
  });

interface InviteLinkRow {
  readonly id: string;
  readonly organization_id: string;
  readonly title: string;
  readonly token_envelope_json: string;
  readonly expires_at: string | null;
  readonly use_count: number;
  readonly created_at: string;
  readonly revoked_at: string | null;
  readonly created_by_user_id: string;
  readonly created_by_name: string | null;
}

const linkStatus = (
  row: Pick<InviteLinkRow, "expires_at" | "revoked_at">,
  now: Date,
) =>
  row.revoked_at !== null
    ? ("revoked" as const)
    : row.expires_at !== null && Date.parse(row.expires_at) <= now.getTime()
      ? ("expired" as const)
      : ("active" as const);

export const listInviteLinks = async (
  db: D1Database,
  bindings: Bindings,
  access: WorkspaceAccess,
  origin: string,
): Promise<ReadonlyArray<WorkspaceInviteLinkData>> => {
  requireAdmin(access);
  const result = await db
    .prepare(
      `SELECT link.id, link.organization_id, link.title,
              link.token_envelope_json, link.expires_at, link.use_count,
              link.created_at, link.revoked_at, link.created_by_user_id,
              "user".name AS created_by_name
         FROM workspace_invite_link AS link
         LEFT JOIN "user" ON "user".id = link.created_by_user_id
        WHERE link.organization_id = ? AND link.revoked_at IS NULL
        ORDER BY link.created_at DESC, link.id DESC
        LIMIT 100`,
    )
    .bind(access.workspaceId)
    .all<InviteLinkRow>();
  if (result.results.length === 0) return [];
  const keyring = await keyringFor(bindings);
  const now = new Date();
  const links = await Promise.all(
    result.results.map(async (row): Promise<WorkspaceInviteLinkData | null> => {
      // One unreadable envelope (for example after a key rotation) hides
      // that link instead of failing the whole list.
      const token = await Effect.runPromise(
        decryptConfigValue(
          keyring,
          envelopeContext(row.id, row.organization_id),
          JSON.parse(row.token_envelope_json) as ConfigValueEnvelope,
        ),
      ).catch((error: unknown) => {
        settingsAuditLogger.warn("Workspace invite link could not be read.", {
          event: "workspace_invite_link_unreadable",
          workspaceId: access.workspaceId,
          inviteLinkId: row.id,
          error,
        });
        return null;
      });
      if (token === null) return null;
      return {
        id: row.id,
        title: row.title,
        url: inviteUrl(origin, token),
        status: linkStatus(row, now),
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
        useCount: row.use_count,
        createdAt: row.created_at,
        createdBy: {
          userId: row.created_by_user_id,
          name: row.created_by_name ?? "",
        },
      };
    }),
  );
  return links.filter((link) => link !== null);
};

export const createInviteLink = async (
  db: D1Database,
  bindings: Bindings,
  access: WorkspaceAccess,
  input: { readonly title: string; readonly expiresAt?: string },
  origin: string,
): Promise<WorkspaceInviteLinkData> => {
  requireAdmin(access);
  const title = input.title.trim();
  const fieldErrors: Array<{ field: string; message: string }> = [];
  if (title.length < 1 || title.length > 80)
    fieldErrors.push({
      field: "title",
      message: "Enter a title between 1 and 80 characters.",
    });
  const now = new Date();
  let expiresAt: string | undefined;
  if (input.expiresAt !== undefined && input.expiresAt.trim() !== "") {
    const parsed = new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime())
      fieldErrors.push({
        field: "expiresAt",
        message: "Choose an expiry in the future.",
      });
    else expiresAt = parsed.toISOString();
  }
  if (fieldErrors.length > 0)
    throw new WorkspaceMembersError(
      "INVALID_WORKSPACE_MEMBERS_REQUEST",
      400,
      "Invite link validation failed.",
      { fieldErrors },
    );
  const keyring = await keyringFor(bindings);
  const id = crypto.randomUUID();
  const token = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const envelope = await Effect.runPromise(
    encryptConfigValue(keyring, envelopeContext(id, access.workspaceId), token),
  );
  const createdAt = now.toISOString();
  await db
    .prepare(
      `INSERT INTO workspace_invite_link (
         id, organization_id, title, token_hash, token_envelope_json,
         expires_at, created_by_user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      access.workspaceId,
      title,
      await sha256Hex(token),
      JSON.stringify(envelope),
      expiresAt ?? null,
      access.userId,
      createdAt,
    )
    .run();
  settingsAuditLogger.info("Workspace invite link created.", {
    event: "workspace_invite_link_created",
    workspaceId: access.workspaceId,
    userId: access.userId,
    inviteLinkId: id,
  });
  const creator = await db
    .prepare('SELECT name FROM "user" WHERE id = ?')
    .bind(access.userId)
    .first<{ name: string }>();
  return {
    id,
    title,
    url: inviteUrl(origin, token),
    status: "active",
    ...(expiresAt === undefined ? {} : { expiresAt }),
    useCount: 0,
    createdAt,
    createdBy: { userId: access.userId, name: creator?.name ?? "" },
  };
};

export const revokeInviteLink = async (
  db: D1Database,
  access: WorkspaceAccess,
  linkId: string,
) => {
  requireAdmin(access);
  const result = await db
    .prepare(
      `UPDATE workspace_invite_link SET revoked_at = ?
        WHERE id = ? AND organization_id = ? AND revoked_at IS NULL
        RETURNING id`,
    )
    .bind(new Date().toISOString(), linkId, access.workspaceId)
    .all();
  if (result.results.length !== 1)
    throw new WorkspaceMembersError(
      "WORKSPACE_INVITE_LINK_NOT_FOUND",
      404,
      "Invite link not found.",
    );
  settingsAuditLogger.info("Workspace invite link revoked.", {
    event: "workspace_invite_link_revoked",
    workspaceId: access.workspaceId,
    userId: access.userId,
    inviteLinkId: linkId,
  });
};

interface InviteLookup {
  readonly status: WorkspaceInvitePreview["status"];
  readonly linkId?: string;
  readonly workspace?: {
    readonly id: string;
    readonly displayName: string;
    readonly shortName: string;
  };
}

export const lookupInvite = async (
  db: D1Database,
  token: string,
): Promise<InviteLookup> => {
  if (!INVITE_TOKEN_PATTERN.test(token)) return { status: "not-found" };
  const row = await db
    .prepare(
      `SELECT link.id, link.expires_at, link.revoked_at,
              organization.id AS workspace_id, organization.name AS display_name,
              organization.slug AS short_name,
              organization.lifecycleState AS lifecycle_state
         FROM workspace_invite_link AS link
         JOIN organization ON organization.id = link.organization_id
        WHERE link.token_hash = ?`,
    )
    .bind(await sha256Hex(token))
    .first<{
      id: string;
      expires_at: string | null;
      revoked_at: string | null;
      workspace_id: string;
      display_name: string;
      short_name: string;
      lifecycle_state: string;
    }>();
  if (row === null || row.lifecycle_state !== "active")
    return { status: "not-found" };
  const status = linkStatus(row, new Date());
  return status === "active"
    ? {
        status: "valid",
        linkId: row.id,
        workspace: {
          id: row.workspace_id,
          displayName: row.display_name,
          shortName: row.short_name,
        },
      }
    : { status };
};

/** Extracts an invite token from a `/join/<token>` callback path, if any. */
export const inviteTokenFromCallback = (callbackURL: unknown) => {
  if (typeof callbackURL !== "string") return undefined;
  const path = (() => {
    try {
      return new URL(callbackURL, "https://dx.invalid").pathname;
    } catch {
      return undefined;
    }
  })();
  const match = path?.match(/^\/join\/([A-Za-z0-9_-]{43})$/);
  return match?.[1];
};

const isMemberOf = async (
  db: D1Database,
  workspaceId: string,
  userId: string,
) =>
  (await db
    .prepare("SELECT 1 FROM member WHERE organizationId = ? AND userId = ?")
    .bind(workspaceId, userId)
    .first()) !== null;

export const acceptInvite = async (
  db: D1Database,
  userId: string,
  token: string,
) => {
  const invite = await lookupInvite(db, token);
  if (invite.status !== "valid" || invite.workspace === undefined)
    throw new WorkspaceMembersError(
      "WORKSPACE_INVITE_INVALID",
      404,
      invite.status === "expired"
        ? "This invite link has expired."
        : invite.status === "revoked"
          ? "This invite link was revoked."
          : "This invite link is not valid.",
    );
  const workspace = invite.workspace;
  const current = await db
    .prepare(
      `SELECT organization.id, organization.name AS display_name,
              organization.slug AS short_name
         FROM member JOIN organization ON organization.id = member.organizationId
        WHERE member.userId = ?`,
    )
    .bind(userId)
    .first<{ id: string; display_name: string; short_name: string }>();
  if (current !== null) {
    if (current.id === workspace.id)
      return {
        workspace: {
          displayName: workspace.displayName,
          shortName: workspace.shortName,
        },
        alreadyMember: true,
      };
    throw new WorkspaceMembersError(
      "WORKSPACE_MEMBERSHIP_EXISTS",
      409,
      `You're already in ${current.display_name}. Leave it before joining another workspace.`,
      {
        workspace: {
          displayName: current.display_name,
          shortName: current.short_name,
        },
      },
    );
  }
  const now = new Date();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO member (id, organizationId, userId, role, createdAt)
           SELECT ?, ?, ?, 'member', ?
            WHERE EXISTS (
              SELECT 1 FROM workspace_invite_link
               WHERE id = ? AND revoked_at IS NULL
                 AND (expires_at IS NULL OR expires_at > ?))`,
        )
        .bind(
          crypto.randomUUID(),
          workspace.id,
          userId,
          now.getTime(),
          invite.linkId,
          now.toISOString(),
        ),
      db
        .prepare(
          `UPDATE workspace_invite_link
              SET use_count = use_count + 1, last_used_at = ?
            WHERE id = ? AND EXISTS (
              SELECT 1 FROM member WHERE organizationId = ? AND userId = ?)`,
        )
        .bind(now.toISOString(), invite.linkId, workspace.id, userId),
    ]);
  } catch {
    // The unique member index rejects a concurrent join. A second click of
    // the same link is already a member; anything else is another workspace.
    if (await isMemberOf(db, workspace.id, userId))
      return {
        workspace: {
          displayName: workspace.displayName,
          shortName: workspace.shortName,
        },
        alreadyMember: true,
      };
    throw new WorkspaceMembersError(
      "WORKSPACE_MEMBERSHIP_EXISTS",
      409,
      "You already belong to a workspace.",
    );
  }
  if (!(await isMemberOf(db, workspace.id, userId)))
    throw new WorkspaceMembersError(
      "WORKSPACE_INVITE_INVALID",
      404,
      "This invite link is not valid.",
    );
  // Joining approves the account past the waitlist, so later sign-ins keep
  // working after they leave the workspace.
  await db
    .prepare(
      `INSERT INTO auth_waitlist (email, status, created_at, updated_at, approved_at)
       SELECT lower(trim(email)), 'approved', ?1, ?1, ?1 FROM "user" WHERE id = ?2
       ON CONFLICT(email) DO UPDATE SET status = 'approved',
         updated_at = excluded.updated_at,
         approved_at = COALESCE(auth_waitlist.approved_at, excluded.approved_at)`,
    )
    .bind(now.toISOString(), userId)
    .run();
  settingsAuditLogger.info("Workspace member joined by invite link.", {
    event: "workspace_member_joined",
    workspaceId: workspace.id,
    userId,
    inviteLinkId: invite.linkId,
  });
  return {
    workspace: {
      displayName: workspace.displayName,
      shortName: workspace.shortName,
    },
    alreadyMember: false,
  };
};

/**
 * Whether a sign-in or sign-up request carries a still-valid invite link. It
 * admits the request past the waitlist or disabled sign-up without recording
 * anything: the approval is written only when the person joins, so a link
 * cannot approve arbitrary emails and revoking it ends its effect.
 */
export const inviteSignupAdmission = async (
  db: D1Database | undefined,
  callbackURL: unknown,
) => {
  const token = inviteTokenFromCallback(callbackURL);
  if (db === undefined || token === undefined) return false;
  return (await lookupInvite(db, token)).status === "valid";
};
