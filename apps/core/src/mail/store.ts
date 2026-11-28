import {
  isReservedUsername,
  MAIL_OPERATOR_LOCAL_PARTS,
  type MailMessageId,
  mailTag,
  newMailLabelId,
  PROJECTLESS_PROJECT_NAME,
  personalAccountUsernameNeedsPick,
} from "@dx/domain";
import type { Bindings } from "../http/types.js";

/**
 * Where mail lives (wiki/agent-mail.md): summaries, labels, and who read
 * what in D1; each message's raw copy and parsed parts in R2 under
 * `mail/<owner user id>/<mail id>`.
 */

type MailBindings = Pick<Bindings, "DB" | "DX_STORAGE">;

/** The person must pick a username before Mail opens. */
export const usernameNeedsPick = personalAccountUsernameNeedsPick;

export interface MailboxOwner {
  readonly userId: string;
  readonly username: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly createdAt: string;
}

const ownerColumns = `"user".id AS userId, personal_account.username AS username,
  "user".name AS name, "user".email AS email, "user".emailVerified AS emailVerified,
  "user".createdAt AS createdAt`;

type OwnerRow = Omit<MailboxOwner, "emailVerified"> & {
  readonly emailVerified: number;
};

const owner = (row: OwnerRow | null): MailboxOwner | undefined =>
  row === null
    ? undefined
    : {
        ...row,
        emailVerified: Number(row.emailVerified) === 1,
        createdAt: String(row.createdAt),
      };

/** The person a user id names, with their current username. */
export const readMailboxOwner = async (db: D1Database, userId: string) =>
  owner(
    await db
      .prepare(
        `SELECT ${ownerColumns} FROM "user"
           JOIN personal_account ON personal_account.user_id = "user".id
          WHERE "user".id = ?`,
      )
      .bind(userId)
      .first<OwnerRow>(),
  );

/**
 * The mailbox a username names: the person who held it before a change
 * (retired names keep delivering to them and win over anyone), or its
 * current holder. A reserved name, or a placeholder no one picked, names
 * no mailbox.
 */
export const findMailboxByUsername = async (
  db: D1Database,
  username: string,
) => {
  const name = username.toLowerCase();
  if (isReservedUsername(name)) return undefined;
  const found = owner(
    await db
      .prepare(
        `SELECT ${ownerColumns} FROM "user"
           JOIN personal_account ON personal_account.user_id = "user".id
          WHERE personal_account.user_id = coalesce(
            (SELECT user_id FROM retired_username WHERE username = ?1 COLLATE NOCASE),
            (SELECT user_id FROM personal_account WHERE username = ?1 COLLATE NOCASE))`,
      )
      .bind(name)
      .first<OwnerRow>(),
  );
  return found === undefined || usernameNeedsPick(found.username)
    ? undefined
    : found;
};

/**
 * Who `postmaster@` and `abuse@` reach: the deployment's admins, as mail
 * standards require an operator to receive them.
 */
export const operatorMailboxes = async (
  bindings: Pick<Bindings, "DB" | "DX_DEPLOYMENT_ADMIN_EMAILS">,
  localPart: string,
) => {
  if (!MAIL_OPERATOR_LOCAL_PARTS.has(localPart) || bindings.DB === undefined)
    return [];
  const emails = (bindings.DX_DEPLOYMENT_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
  if (emails.length === 0) return [];
  const { results } = await bindings.DB.prepare(
    `SELECT ${ownerColumns} FROM "user"
       JOIN personal_account ON personal_account.user_id = "user".id
      WHERE lower("user".email) IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(emails))
    .all<OwnerRow>();
  return results.flatMap((row) => owner(row) ?? []);
};

export interface MailboxSettingRow {
  readonly user_id: string;
  readonly agent_access: "all" | "project" | "none";
  readonly sending_suspended_at: string | null;
}

/** The person's settings without making a row: defaults when none. */
export const readMailboxSetting = async (
  db: D1Database,
  userId: string,
): Promise<MailboxSettingRow> =>
  (await db
    .prepare(
      "SELECT user_id, agent_access, sending_suspended_at FROM mailbox WHERE user_id = ?",
    )
    .bind(userId)
    .first<MailboxSettingRow>()) ?? {
    user_id: userId,
    agent_access: "all",
    sending_suspended_at: null,
  };

export const updateMailboxSetting = async (
  db: D1Database,
  userId: string,
  change: { readonly agentAccess?: "all" | "project" | "none" },
) => {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO mailbox (user_id, agent_access, created_at, updated_at)
       VALUES (?1, coalesce(?2, 'all'), ?3, ?3)
       ON CONFLICT (user_id) DO UPDATE
         SET agent_access = coalesce(?2, agent_access), updated_at = ?3`,
    )
    .bind(userId, change.agentAccess ?? null, now)
    .run();
};

/**
 * A deployment admin pauses or resumes a person's sending. Returns false
 * when no account has that user ID.
 */
export const setMailSendingSuspended = async (
  db: D1Database,
  userId: string,
  suspended: boolean,
) => {
  const exists = await db
    .prepare(`SELECT 1 AS found FROM "user" WHERE id = ?`)
    .bind(userId)
    .first<number>("found");
  if (exists === null) return false;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO mailbox (user_id, agent_access, sending_suspended_at, created_at, updated_at)
       VALUES (?1, 'all', ?2, ?3, ?3)
       ON CONFLICT (user_id) DO UPDATE
         SET sending_suspended_at = ?2, updated_at = ?3`,
    )
    .bind(userId, suspended ? now : null, now)
    .run();
  return true;
};

// ── Project tags ─────────────────────────────────────────────────────────

/**
 * Projects the person can reach, as the app's own rule has it: their
 * personal Projects and those of their one active workspace. "No Project"
 * and deleted Projects never take mail.
 */
const reachableProjectsSql = `
  SELECT projects.id, projects.name FROM projects
   WHERE projects.deleted_at IS NULL AND projects.name != ?2
     AND ((projects.workspace_id IS NULL AND projects.owner_user_id = ?1)
       OR projects.workspace_id = (
            SELECT member.organizationId FROM member
              JOIN organization ON organization.id = member.organizationId
             WHERE member.userId = ?1 AND organization.lifecycleState = 'active'))`;

/** The person's fixed `+tag` for a Project, made on first need. */
export const ensureProjectTag = async (
  db: D1Database,
  userId: string,
  projectId: string,
  projectName: string,
): Promise<string> => {
  const read = () =>
    db
      .prepare(
        "SELECT tag FROM mailbox_project_tag WHERE user_id = ? AND project_id = ?",
      )
      .bind(userId, projectId)
      .first<string>("tag");
  const existing = await read();
  if (existing !== null) return existing;
  for (let attempt = 0; attempt < 50; attempt++) {
    const tag = mailTag(projectName, attempt);
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO mailbox_project_tag (user_id, tag, project_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(userId, tag, projectId, new Date().toISOString())
      .run();
    if ((inserted.meta.changes ?? 0) > 0) return tag;
    // Another request made this Project's tag first.
    const raced = await read();
    if (raced !== null) return raced;
  }
  throw new Error("No free address was found for this Project.");
};

/**
 * The Project a `+tag` names in this mailbox. A tag that does not exist yet
 * is made when exactly one Project the person can reach has that simplified
 * name; otherwise the mail goes to the plain Inbox.
 */
export const resolveProjectTag = async (
  db: D1Database,
  userId: string,
  tag: string,
): Promise<
  { readonly projectId: string; readonly tag: string } | undefined
> => {
  const stored = await db
    .prepare(
      `SELECT mailbox_project_tag.project_id, projects.deleted_at
         FROM mailbox_project_tag
         LEFT JOIN projects ON projects.id = mailbox_project_tag.project_id
        WHERE mailbox_project_tag.user_id = ? AND mailbox_project_tag.tag = ?`,
    )
    .bind(userId, tag)
    .first<{ project_id: string; deleted_at: string | null }>();
  // A tag of a deleted Project is never given to another one.
  if (stored !== null)
    return stored.deleted_at === null
      ? { projectId: stored.project_id, tag }
      : undefined;
  const { results } = await db
    .prepare(reachableProjectsSql)
    .bind(userId, PROJECTLESS_PROJECT_NAME)
    .all<{ id: string; name: string }>();
  const matching = results.filter(({ name }) => mailTag(name) === tag);
  if (matching.length !== 1 || matching[0] === undefined) return undefined;
  const made = await ensureProjectTag(
    db,
    userId,
    matching[0].id,
    matching[0].name,
  );
  return made === tag ? { projectId: matching[0].id, tag } : undefined;
};

/** The person's tags for Projects they can still reach, with names. */
export const listProjectTags = async (db: D1Database, userId: string) => {
  const { results } = await db
    .prepare(
      `SELECT mailbox_project_tag.tag, mailbox_project_tag.project_id, reachable.name
         FROM mailbox_project_tag
         JOIN (${reachableProjectsSql}) AS reachable
           ON reachable.id = mailbox_project_tag.project_id
        WHERE mailbox_project_tag.user_id = ?1
        ORDER BY reachable.name COLLATE NOCASE`,
    )
    .bind(userId, PROJECTLESS_PROJECT_NAME)
    .all<{ tag: string; project_id: string; name: string }>();
  return results;
};

/** Projects the person can reach, for "Start thread". */
export const listReachableProjects = async (db: D1Database, userId: string) => {
  const { results } = await db
    .prepare(`${reachableProjectsSql} ORDER BY projects.name COLLATE NOCASE`)
    .bind(userId, PROJECTLESS_PROJECT_NAME)
    .all<{ id: string; name: string }>();
  return results;
};

// ── Project mail settings ────────────────────────────────────────────────

export type MailAgentMode = "low" | "medium" | "high" | "ultra";

// ── Mail items ───────────────────────────────────────────────────────────

/** A message's parsed parts as R2 keeps them beside its raw copy. */
export interface StoredMailParts {
  readonly text: string;
  readonly html?: string;
  readonly attachments: ReadonlyArray<{
    readonly filename: string;
    readonly mimeType: string;
    readonly size: number;
  }>;
}

export interface MailItemRow {
  readonly id: MailMessageId;
  readonly owner_user_id: string;
  readonly direction: "in" | "out";
  readonly folder: "inbox" | "sent" | "archive" | "spam";
  readonly tag: string | null;
  readonly project_id: string | null;
  readonly private: number;
  readonly read_at: string | null;
  readonly received_at: string;
  readonly header_from: string | null;
  readonly from_address: string | null;
  readonly envelope_from: string | null;
  readonly rcpt_to: string;
  readonly to_addresses: string;
  readonly cc_addresses: string;
  readonly subject: string | null;
  readonly message_id: string | null;
  readonly conversation_key: string;
  readonly dmarc: string | null;
  readonly authenticated: number;
  readonly size: number;
  readonly has_attachments: number;
  readonly r2_key: string | null;
  readonly preview: string | null;
  readonly disposition: string;
  readonly thread_id: string | null;
}

export const mailObjectKey = (ownerUserId: string, id: string) =>
  `mail/${ownerUserId}/${id}`;

/**
 * The conversation trusted mail joins: the conversation of the newest
 * trusted message it answers that this mailbox holds, else its oldest
 * reference, else its own Message-ID. Untrusted mail never calls this; it
 * is its own conversation (keyed by its mail id), so a forged copy can't
 * join, or be joined by, real mail.
 */
export const conversationKeyFor = async (
  db: D1Database,
  ownerUserId: string,
  messageId: string,
  references: ReadonlyArray<string>,
) => {
  for (const reference of [...references].reverse()) {
    const key = await db
      .prepare(
        `SELECT conversation_key FROM mail_item
          WHERE owner_user_id = ? AND message_id = ? AND authenticated = 1
          LIMIT 1`,
      )
      .bind(ownerUserId, reference)
      .first<string>("conversation_key");
    if (key !== null) return key;
  }
  return references[0] ?? messageId;
};

/**
 * Stores one email: its raw copy and parts in R2 (when `body` is given),
 * then its row. Bodies go first, so a row never names a missing object.
 */
/**
 * Inbound flood caps, checked in the same statement as the insert so
 * concurrent deliveries can't all pass them: at most `perSender` emails from
 * `sender`, and `perMailbox` from anyone, as trusted as this one since
 * `since` (see `recentMailFrom`).
 */
export interface MailFloodCap {
  readonly sender:
    | { readonly envelopeFrom: string }
    | { readonly fromDomain: string };
  readonly perSender: number;
  readonly perMailbox: number;
  readonly since: Date;
}

/**
 * Stores one email; false when `cap` refused it, and then nothing of it is
 * kept.
 */
export const insertMailItem = async (
  bindings: MailBindings,
  row: Omit<MailItemRow, "r2_key">,
  body?: { readonly raw: Uint8Array; readonly parts: StoredMailParts },
  cap?: MailFloodCap,
): Promise<boolean> => {
  const db = bindings.DB;
  if (db === undefined) throw new Error("Mail requires the D1 binding.");
  let key: string | null = null;
  if (body !== undefined && bindings.DX_STORAGE !== undefined) {
    key = mailObjectKey(row.owner_user_id, row.id);
    await bindings.DX_STORAGE.put(`${key}.eml`, body.raw, {
      httpMetadata: { contentType: "message/rfc822" },
    });
    await bindings.DX_STORAGE.put(`${key}.json`, JSON.stringify(body.parts), {
      httpMetadata: { contentType: "application/json" },
    });
  }
  const inserted = await db
    .prepare(
      `INSERT INTO mail_item (
         id, owner_user_id, direction, folder, tag, project_id, private, read_at,
         received_at, header_from, from_address, envelope_from, rcpt_to,
         to_addresses, cc_addresses, subject, message_id, conversation_key,
         dmarc, authenticated, size, has_attachments, r2_key, preview,
         disposition, thread_id
       ) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26
          WHERE ?27 IS NULL OR (
            (SELECT count(*) FROM mail_item
              WHERE owner_user_id = ?2 AND direction = 'in'
                AND (?28 IS NULL OR envelope_from = ?28)
                AND (?29 IS NULL OR from_address LIKE '%@' || ?29)
                AND received_at > ?27 AND authenticated = ?20) < ?30
            AND (SELECT count(*) FROM mail_item
              WHERE owner_user_id = ?2 AND direction = 'in'
                AND received_at > ?27 AND authenticated = ?20) < ?31)`,
    )
    .bind(
      row.id,
      row.owner_user_id,
      row.direction,
      row.folder,
      row.tag,
      row.project_id,
      row.private,
      row.read_at,
      row.received_at,
      row.header_from?.slice(0, 998) ?? null,
      row.from_address?.slice(0, 320) ?? null,
      row.envelope_from?.slice(0, 998) ?? null,
      row.rcpt_to.slice(0, 998),
      row.to_addresses,
      row.cc_addresses,
      row.subject?.slice(0, 998) ?? null,
      row.message_id?.slice(0, 998) ?? null,
      row.conversation_key.slice(0, 998),
      row.dmarc?.slice(0, 32) ?? null,
      row.authenticated,
      row.size,
      row.has_attachments,
      key,
      row.preview?.slice(0, 400) ?? null,
      row.disposition,
      row.thread_id,
      cap?.since.toISOString() ?? null,
      cap !== undefined && "envelopeFrom" in cap.sender
        ? cap.sender.envelopeFrom
        : null,
      cap !== undefined && "fromDomain" in cap.sender
        ? cap.sender.fromDomain
        : null,
      cap?.perSender ?? null,
      cap?.perMailbox ?? null,
    )
    .run();
  if ((inserted.meta.changes ?? 0) > 0) return true;
  if (key !== null)
    await bindings.DX_STORAGE?.delete([`${key}.eml`, `${key}.json`]);
  return false;
};

/** Records what dx did with an email, and the Thread it reached. */
export const setMailDisposition = (
  db: D1Database,
  mailId: string,
  disposition: string,
  change: { readonly threadId?: string | null; readonly folder?: string } = {},
) =>
  db
    .prepare(
      `UPDATE mail_item
          SET disposition = ?2,
              thread_id = CASE WHEN ?3 THEN ?4 ELSE thread_id END,
              folder = COALESCE(?5, folder)
        WHERE id = ?1`,
    )
    .bind(
      mailId,
      disposition,
      change.threadId === undefined ? 0 : 1,
      change.threadId ?? null,
      change.folder ?? null,
    )
    .run();

export const readMailItem = (db: D1Database, ownerUserId: string, id: string) =>
  db
    .prepare("SELECT * FROM mail_item WHERE id = ? AND owner_user_id = ?")
    .bind(id, ownerUserId)
    .first<MailItemRow>();

/** An email's parsed parts from R2, or a note when they are gone. */
export const readMailParts = async (
  bindings: MailBindings,
  row: Pick<MailItemRow, "r2_key">,
): Promise<StoredMailParts> => {
  const object =
    row.r2_key === null
      ? null
      : await bindings.DX_STORAGE?.get(`${row.r2_key}.json`);
  return object === null || object === undefined
    ? { text: "(This email's body is no longer stored.)", attachments: [] }
    : ((await object.json()) as StoredMailParts);
};

/** An email's raw copy, for attachments. */
export const readMailRaw = async (
  bindings: MailBindings,
  row: Pick<MailItemRow, "r2_key">,
) => {
  const object =
    row.r2_key === null
      ? null
      : await bindings.DX_STORAGE?.get(`${row.r2_key}.eml`);
  return object === null || object === undefined
    ? undefined
    : new Uint8Array(await object.arrayBuffer());
};

/** Whether a sender's mail is always private in this mailbox. */
export const isPrivateSender = async (
  db: D1Database,
  ownerUserId: string,
  address: string | undefined,
) =>
  address !== undefined &&
  (await db
    .prepare(
      "SELECT 1 AS private FROM mail_private_sender WHERE user_id = ? AND address = ?",
    )
    .bind(ownerUserId, address.toLowerCase())
    .first<number>("private")) !== null;

export const listPrivateSenders = async (db: D1Database, userId: string) => {
  const { results } = await db
    .prepare(
      "SELECT address FROM mail_private_sender WHERE user_id = ? ORDER BY address",
    )
    .bind(userId)
    .all<{ address: string }>();
  return results.map(({ address }) => address);
};

export const setPrivateSender = async (
  db: D1Database,
  userId: string,
  address: string,
  isPrivate: boolean,
) => {
  const normalized = address.trim().toLowerCase();
  if (isPrivate)
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO mail_private_sender (user_id, address, created_at) VALUES (?, ?, ?)",
        )
        .bind(userId, normalized, new Date().toISOString()),
      // Mail already received from them becomes private too.
      db
        .prepare(
          "UPDATE mail_item SET private = 1 WHERE owner_user_id = ? AND from_address = ?",
        )
        .bind(userId, normalized),
    ]);
  else
    await db
      .prepare(
        "DELETE FROM mail_private_sender WHERE user_id = ? AND address = ?",
      )
      .bind(userId, normalized)
      .run();
};

// ── Lists and conversations ──────────────────────────────────────────────

export interface ConversationFilter {
  readonly folder?: "inbox" | "sent" | "archive" | "spam";
  readonly labelId?: string;
  readonly tag?: string;
  readonly query?: string;
  /** `<latest received_at>|<conversation key>` of the last row seen. */
  readonly before?: string;
  readonly limit: number;
}

/**
 * Conversations with at least one email that matches the filter, newest
 * first. A folder matches its own emails; a label or tag matches any email
 * outside Spam.
 */
export const listConversationKeys = async (
  db: D1Database,
  ownerUserId: string,
  filter: ConversationFilter,
) => {
  const cut = (filter.before ?? "").indexOf("|");
  const beforeAt = cut < 0 ? "" : (filter.before ?? "").slice(0, cut);
  const beforeKey = cut < 0 ? "" : (filter.before ?? "").slice(cut + 1);
  const query = filter.query?.trim().toLowerCase();
  const { results } = await db
    .prepare(
      `SELECT conversation_key AS key, max(received_at) AS latest FROM mail_item
        WHERE owner_user_id = ?1
          AND (?2 IS NULL OR folder = ?2)
          AND (?2 IS NOT NULL OR folder != 'spam')
          AND (?3 IS NULL OR id IN (SELECT mail_id FROM mail_item_label WHERE label_id = ?3))
          AND (?4 IS NULL OR tag = ?4)
          AND (?5 IS NULL OR instr(lower(coalesce(subject, '') || ' ' ||
               coalesce(header_from, '') || ' ' || coalesce(preview, '') || ' ' ||
               to_addresses), ?5) > 0)
        GROUP BY conversation_key
       HAVING ?6 IS NULL OR latest < ?6 OR (latest = ?6 AND key < ?7)
        ORDER BY latest DESC, key DESC
        LIMIT ?8`,
    )
    .bind(
      ownerUserId,
      filter.folder ?? null,
      filter.labelId ?? null,
      filter.tag ?? null,
      query === undefined || query === "" ? null : query,
      beforeAt || null,
      beforeKey,
      filter.limit,
    )
    .all<{ key: string; latest: string }>();
  return results;
};

/** Every email of the conversations named, oldest first. */
export const conversationItems = async (
  db: D1Database,
  ownerUserId: string,
  keys: ReadonlyArray<string>,
) => {
  if (keys.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT * FROM mail_item
        WHERE owner_user_id = ? AND conversation_key IN (SELECT value FROM json_each(?))
        ORDER BY received_at, id`,
    )
    .bind(ownerUserId, JSON.stringify(keys))
    .all<MailItemRow>();
  return results;
};

/** Labels on the emails named, by email. */
export const labelsOf = async (
  db: D1Database,
  mailIds: ReadonlyArray<string>,
) => {
  const byMail = new Map<
    string,
    Array<{ id: string; name: string; automatic: boolean }>
  >();
  if (mailIds.length === 0) return byMail;
  const { results } = await db
    .prepare(
      `SELECT mail_item_label.mail_id, mail_label.id, mail_label.name, mail_item_label.source
         FROM mail_item_label JOIN mail_label ON mail_label.id = mail_item_label.label_id
        WHERE mail_item_label.mail_id IN (SELECT value FROM json_each(?))
        ORDER BY mail_label.name`,
    )
    .bind(JSON.stringify(mailIds))
    .all<{ mail_id: string; id: string; name: string; source: string }>();
  for (const row of results)
    byMail.set(row.mail_id, [
      ...(byMail.get(row.mail_id) ?? []),
      { id: row.id, name: row.name, automatic: row.source === "clef" },
    ]);
  return byMail;
};

/** Which Threads read the emails named, with their titles. */
export const readersOf = async (
  db: D1Database,
  mailIds: ReadonlyArray<string>,
) => {
  const byMail = new Map<
    string,
    Array<{ threadId: string; title: string; readAt: string }>
  >();
  if (mailIds.length === 0) return byMail;
  const { results } = await db
    .prepare(
      `SELECT mail_read_log.mail_id, mail_read_log.thread_id, mail_read_log.read_at,
              coalesce(threads.title, 'Thread') AS title
         FROM mail_read_log JOIN threads ON threads.id = mail_read_log.thread_id
        WHERE mail_read_log.mail_id IN (SELECT value FROM json_each(?))
          AND threads.lifecycle_state != 'deleted'
        ORDER BY mail_read_log.read_at`,
    )
    .bind(JSON.stringify(mailIds))
    .all<{
      mail_id: string;
      thread_id: string;
      read_at: string;
      title: string;
    }>();
  for (const row of results)
    byMail.set(row.mail_id, [
      ...(byMail.get(row.mail_id) ?? []),
      { threadId: row.thread_id, title: row.title, readAt: row.read_at },
    ]);
  return byMail;
};

/** Titles of the Threads named, when they are live. */
export const threadTitles = async (
  db: D1Database,
  threadIds: ReadonlyArray<string>,
) => {
  const titles = new Map<string, string>();
  if (threadIds.length === 0) return titles;
  const { results } = await db
    .prepare(
      `SELECT id, coalesce(title, 'Thread') AS title FROM threads
        WHERE id IN (SELECT value FROM json_each(?)) AND lifecycle_state != 'deleted'`,
    )
    .bind(JSON.stringify([...new Set(threadIds)]))
    .all<{ id: string; title: string }>();
  for (const { id, title } of results) titles.set(id, title);
  return titles;
};

/** Changes a whole conversation; sent copies keep their folder. */
export const updateConversation = async (
  db: D1Database,
  ownerUserId: string,
  key: string,
  change: {
    readonly read?: boolean;
    readonly folder?: "inbox" | "archive" | "spam";
    readonly private?: boolean;
    readonly addLabels?: ReadonlyArray<string>;
    readonly removeLabels?: ReadonlyArray<string>;
  },
) => {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (change.read === true)
    statements.push(
      db
        .prepare(
          `UPDATE mail_item SET read_at = ?3
            WHERE owner_user_id = ?1 AND conversation_key = ?2 AND direction = 'in'
              AND read_at IS NULL`,
        )
        .bind(ownerUserId, key, now),
    );
  if (change.read === false)
    statements.push(
      db
        .prepare(
          `UPDATE mail_item SET read_at = NULL
            WHERE owner_user_id = ?1 AND conversation_key = ?2 AND direction = 'in'`,
        )
        .bind(ownerUserId, key),
    );
  if (change.folder !== undefined)
    statements.push(
      db
        .prepare(
          `UPDATE mail_item SET folder = ?3
            WHERE owner_user_id = ?1 AND conversation_key = ?2 AND direction = 'in'`,
        )
        .bind(ownerUserId, key, change.folder),
    );
  if (change.private !== undefined)
    statements.push(
      db
        .prepare(
          "UPDATE mail_item SET private = ?3 WHERE owner_user_id = ?1 AND conversation_key = ?2",
        )
        .bind(ownerUserId, key, change.private ? 1 : 0),
    );
  for (const labelId of change.addLabels ?? [])
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO mail_item_label (mail_id, label_id, source, created_at)
           SELECT mail_item.id, mail_label.id, 'user', ?4 FROM mail_item
             JOIN mail_label ON mail_label.id = ?3 AND mail_label.user_id = ?1
            WHERE mail_item.owner_user_id = ?1 AND mail_item.conversation_key = ?2`,
        )
        .bind(ownerUserId, key, labelId, now),
    );
  for (const labelId of change.removeLabels ?? [])
    statements.push(
      db
        .prepare(
          `DELETE FROM mail_item_label WHERE label_id = ?3 AND mail_id IN (
             SELECT id FROM mail_item WHERE owner_user_id = ?1 AND conversation_key = ?2)`,
        )
        .bind(ownerUserId, key, labelId),
    );
  if (statements.length > 0) await db.batch(statements);
};

/** Unread conversations in the Inbox and in Spam. */
export const unreadCounts = async (db: D1Database, ownerUserId: string) => {
  const { results } = await db
    .prepare(
      `SELECT folder, count(DISTINCT conversation_key) AS unread FROM mail_item
        WHERE owner_user_id = ? AND read_at IS NULL AND direction = 'in'
          AND folder IN ('inbox', 'spam')
        GROUP BY folder`,
    )
    .bind(ownerUserId)
    .all<{ folder: string; unread: number }>();
  return {
    inbox: results.find(({ folder }) => folder === "inbox")?.unread ?? 0,
    spam: results.find(({ folder }) => folder === "spam")?.unread ?? 0,
  };
};

/** Unread Inbox conversations by tag. */
export const unreadByTag = async (db: D1Database, ownerUserId: string) => {
  const { results } = await db
    .prepare(
      `SELECT tag, count(DISTINCT conversation_key) AS unread FROM mail_item
        WHERE owner_user_id = ? AND read_at IS NULL AND direction = 'in'
          AND folder = 'inbox' AND tag IS NOT NULL
        GROUP BY tag`,
    )
    .bind(ownerUserId)
    .all<{ tag: string; unread: number }>();
  return new Map(results.map(({ tag, unread }) => [tag, unread]));
};

// ── Labels ───────────────────────────────────────────────────────────────

/** The labels dx's automatic labelling puts on mail. */
export const AUTO_LABELS = {
  codes: "Sign-in & codes",
  newsletter: "Newsletters",
  receipt: "Receipts",
} as const;

export const listLabels = async (db: D1Database, userId: string) => {
  const { results } = await db
    .prepare(
      `SELECT mail_label.id, mail_label.name, mail_label.kind,
              (SELECT count(DISTINCT mail_item.conversation_key) FROM mail_item_label
                 JOIN mail_item ON mail_item.id = mail_item_label.mail_id
                WHERE mail_item_label.label_id = mail_label.id
                  AND mail_item.folder = 'inbox' AND mail_item.read_at IS NULL
                  AND mail_item.direction = 'in') AS unread
         FROM mail_label WHERE mail_label.user_id = ?
        ORDER BY mail_label.kind DESC, mail_label.name COLLATE NOCASE`,
    )
    .bind(userId)
    .all<{ id: string; name: string; kind: "user" | "auto"; unread: number }>();
  return results;
};

export class MailLabelTaken extends Error {}

export const createLabel = async (
  db: D1Database,
  userId: string,
  name: string,
  kind: "user" | "auto" = "user",
) => {
  const id = newMailLabelId();
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO mail_label (id, user_id, name, kind, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, name.trim(), kind, new Date().toISOString())
    .run();
  if ((inserted.meta.changes ?? 0) === 0) throw new MailLabelTaken();
  return { id, name: name.trim(), kind, unread: 0 };
};

/** An automatic label's id, made on first use. */
export const ensureAutoLabel = async (
  db: D1Database,
  userId: string,
  name: string,
): Promise<string | undefined> => {
  const read = () =>
    db
      .prepare("SELECT id FROM mail_label WHERE user_id = ? AND name = ?")
      .bind(userId, name)
      .first<string>("id");
  const existing = await read();
  if (existing !== null) return existing;
  try {
    return (await createLabel(db, userId, name, "auto")).id;
  } catch {
    return (await read()) ?? undefined;
  }
};

export const renameLabel = async (
  db: D1Database,
  userId: string,
  labelId: string,
  name: string,
) => {
  const updated = await db
    .prepare(
      "UPDATE OR IGNORE mail_label SET name = ? WHERE id = ? AND user_id = ? AND kind = 'user'",
    )
    .bind(name.trim(), labelId, userId)
    .run();
  return (updated.meta.changes ?? 0) > 0;
};

export const deleteLabel = async (
  db: D1Database,
  userId: string,
  labelId: string,
) => {
  const owned = await db
    .prepare("SELECT 1 AS owned FROM mail_label WHERE id = ? AND user_id = ?")
    .bind(labelId, userId)
    .first<number>("owned");
  if (owned === null) return false;
  await db.batch([
    db.prepare("DELETE FROM mail_item_label WHERE label_id = ?").bind(labelId),
    db.prepare("DELETE FROM mail_label WHERE id = ?").bind(labelId),
  ]);
  return true;
};

/** Puts a label on an email, as dx's automatic labelling chose it. */
export const applyAutoLabel = (
  db: D1Database,
  mailId: string,
  labelId: string,
) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO mail_item_label (mail_id, label_id, source, created_at)
       VALUES (?, ?, 'clef', ?)`,
    )
    .bind(mailId, labelId, new Date().toISOString())
    .run();

// ── Agents ───────────────────────────────────────────────────────────────

/** How a Thread's agent may read its owner's mailbox. */
export interface AgentMailScope {
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly projectId: string;
  /** Shared with the workspace: only its Project's tag and claimed mail. */
  readonly shared: boolean;
  readonly access: "all" | "project";
}

/**
 * The mail a Thread's agent may read, as SQL over `mail_item`, with its
 * bindings. Never Spam, never private mail, never another Project's tag.
 * A shared Thread reads only its Project's tag and the mail it claimed.
 * Labels play no part: they never widen access.
 */
export const agentScopeSql = (scope: AgentMailScope) => {
  // Claimed mail stays readable only while the owner lets agents read
  // their plain inbox.
  const claims = scope.shared && scope.access === "all";
  if (scope.shared || scope.access === "project")
    return {
      sql: `owner_user_id = ? AND private = 0 AND folder != 'spam'
        AND ((tag IS NOT NULL AND project_id = ?)${
          claims
            ? " OR id IN (SELECT mail_id FROM mail_thread_claim WHERE thread_id = ?)"
            : ""
        })`,
      params: claims
        ? [scope.ownerUserId, scope.projectId, scope.threadId]
        : [scope.ownerUserId, scope.projectId],
    };
  return {
    sql: `owner_user_id = ? AND private = 0 AND folder != 'spam'
      AND (tag IS NULL OR project_id = ?)`,
    params: [scope.ownerUserId, scope.projectId],
  };
};

/** Records that a Thread's agent read an email. */
export const logMailRead = (db: D1Database, mailId: string, threadId: string) =>
  db
    .prepare(
      `INSERT INTO mail_read_log (mail_id, thread_id, read_at) VALUES (?, ?, ?)
       ON CONFLICT (mail_id, thread_id) DO UPDATE SET read_at = excluded.read_at`,
    )
    .bind(mailId, threadId, new Date().toISOString())
    .run();

/**
 * How many emails these Threads' agents read that a shared Thread could not:
 * anything but their Project's tag and mail they claimed (agentScopeSql).
 * Sharing shows earlier tool results to viewers, so the owner confirms first.
 */
export const countMailReadsBeyondSharedScope = async (
  db: D1Database,
  threadIds: ReadonlyArray<string>,
) =>
  threadIds.length === 0
    ? 0
    : ((await db
        .prepare(
          `SELECT COUNT(DISTINCT log.mail_id) AS count
             FROM mail_read_log AS log
             JOIN threads AS thread ON thread.id = log.thread_id
             JOIN mail_item AS mail ON mail.id = log.mail_id
            WHERE log.thread_id IN (SELECT value FROM json_each(?1))
              AND NOT (mail.tag IS NOT NULL AND mail.project_id = thread.project_id)
              AND NOT EXISTS (
                SELECT 1 FROM mail_thread_claim AS claim
                 WHERE claim.mail_id = log.mail_id
                   AND claim.thread_id = log.thread_id)`,
        )
        .bind(JSON.stringify(threadIds))
        .first<number>("count")) ?? 0);

/** The same count for a Thread family: a root and its children. */
export const countFamilyMailReadsBeyondSharedScope = async (
  db: D1Database,
  rootThreadId: string,
  ownerUserId: string,
) =>
  countMailReadsBeyondSharedScope(
    db,
    (
      await db
        .prepare(
          `SELECT id FROM threads
            WHERE (id = ?1 OR parent_thread_id = ?1) AND owner_user_id = ?2
              AND lifecycle_state != 'deleted'`,
        )
        .bind(rootThreadId, ownerUserId)
        .all<{ id: string }>()
    ).results.map(({ id }) => id),
  );

/** Attaches mail a shared Thread's wait_for_email claimed. */
export const claimMailForThread = (
  db: D1Database,
  mailId: string,
  threadId: string,
) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO mail_thread_claim (mail_id, thread_id, claimed_at)
       VALUES (?, ?, ?)`,
    )
    .bind(mailId, threadId, new Date().toISOString())
    .run();

/**
 * A deleted Thread's links to mail: who read what and what it claimed. The
 * mail itself is the person's and stays; its references stay too, so a late
 * reply to the Thread's conversation starts nothing.
 */
export const deleteThreadMail = async (
  bindings: MailBindings,
  threadId: string,
) => {
  const db = bindings.DB;
  if (db === undefined) return;
  await db.batch([
    db.prepare("DELETE FROM mail_read_log WHERE thread_id = ?").bind(threadId),
    db
      .prepare("DELETE FROM mail_thread_claim WHERE thread_id = ?")
      .bind(threadId),
  ]);
};

/**
 * How many trusted (or untrusted) emails one sender, or anyone, put in a
 * mailbox lately. A trusted sender is its authenticated From domain, which
 * it can't rotate; an untrusted one is its envelope sender.
 */
export const recentMailFrom = async (
  db: D1Database,
  ownerUserId: string,
  sender:
    | { readonly envelopeFrom: string }
    | { readonly fromDomain: string }
    | undefined,
  sinceMs: number,
  authenticated: boolean,
) =>
  (await db
    .prepare(
      `SELECT count(*) AS count FROM mail_item
        WHERE owner_user_id = ?1 AND direction = 'in'
          AND (?2 IS NULL OR envelope_from = ?2)
          AND (?3 IS NULL OR from_address LIKE '%@' || ?3)
          AND received_at > ?4 AND authenticated = ?5`,
    )
    .bind(
      ownerUserId,
      sender !== undefined && "envelopeFrom" in sender
        ? sender.envelopeFrom
        : null,
      sender !== undefined && "fromDomain" in sender ? sender.fromDomain : null,
      new Date(Date.now() - sinceMs).toISOString(),
      authenticated ? 1 : 0,
    )
    .first<number>("count")) ?? 0;
