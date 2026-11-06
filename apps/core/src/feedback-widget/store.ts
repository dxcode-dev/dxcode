import { MAX_FEEDBACK_WIDGET_ORIGINS } from "@dx/domain";
import { manageableSql } from "../projects/orb-scripts.js";

/**
 * D1 reads and writes for the Feedback Widget: one row per Project that has
 * ever turned it on, its allowed origins, consents waiting to be claimed by a
 * widget panel, and the grants those panels hold.
 */

/** Unclaimed consents expire after this long. */
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

const randomBase32 = (length: number) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => alphabet[byte % 32]).join("");
};

export const newClientId = () => `fbw_${randomBase32(24)}`;

export const newGrantToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `dxw_${btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}`;
};

export const sha256Hex = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export interface ProjectWidget {
  readonly clientId: string | undefined;
  readonly origins: ReadonlyArray<string>;
}

const readOrigins = async (db: D1Database, projectId: string) =>
  (
    await db
      .prepare(
        `SELECT origin FROM project_feedback_widget_origin
          WHERE project_id = ? ORDER BY created_at, origin`,
      )
      .bind(projectId)
      .all<{ origin: string }>()
  ).results.map(({ origin }) => origin);

export const readProjectWidget = async (
  db: D1Database,
  projectId: string,
): Promise<ProjectWidget> => {
  const [row, origins] = await Promise.all([
    db
      .prepare(
        "SELECT client_id FROM project_feedback_widget WHERE project_id = ?",
      )
      .bind(projectId)
      .first<{ client_id: string | null }>(),
    readOrigins(db, projectId),
  ]);
  return { clientId: row?.client_id ?? undefined, origins };
};

export const canManageProject = async (
  db: D1Database,
  projectId: string,
  userId: string,
) =>
  (
    await db
      .prepare(`SELECT ${manageableSql} AS allowed`)
      .bind(projectId, userId)
      .first<{ allowed: number }>()
  )?.allowed === 1;

/** Turns the widget on, keeping the client ID it already has. */
export const enableWidget = async (
  db: D1Database,
  projectId: string,
  userId: string,
) => {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO project_feedback_widget
         (project_id, client_id, enabled_by_user_id, enabled_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (project_id) DO UPDATE SET
         enabled_by_user_id = CASE WHEN client_id IS NULL
           THEN excluded.enabled_by_user_id ELSE enabled_by_user_id END,
         enabled_at = CASE WHEN client_id IS NULL
           THEN excluded.enabled_at ELSE enabled_at END,
         client_id = COALESCE(client_id, excluded.client_id),
         updated_at = excluded.updated_at`,
    )
    .bind(projectId, newClientId(), userId, now)
    .run();
};

/**
 * Turns the widget off: the script stops everywhere and every grant ends.
 * Allowed origins stay for the next time it is turned on.
 */
export const disableWidget = async (db: D1Database, projectId: string) => {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE project_feedback_widget SET client_id = NULL, updated_at = ?2
          WHERE project_id = ?1`,
      )
      .bind(projectId, now),
    db
      .prepare("DELETE FROM feedback_widget_grant WHERE project_id = ?")
      .bind(projectId),
  ]);
};

export const addOrigin = async (
  db: D1Database,
  projectId: string,
  origin: string,
): Promise<"added" | "too-many"> => {
  const result = await db
    .prepare(
      `INSERT INTO project_feedback_widget_origin (project_id, origin, created_at)
       SELECT ?1, ?2, ?3
        WHERE (SELECT count(*) FROM project_feedback_widget_origin
                WHERE project_id = ?1) < ?4
       ON CONFLICT (project_id, origin) DO NOTHING`,
    )
    .bind(
      projectId,
      origin,
      new Date().toISOString(),
      MAX_FEEDBACK_WIDGET_ORIGINS,
    )
    .run();
  if (result.meta.changes === 1) return "added";
  const existing = await db
    .prepare(
      "SELECT 1 AS present FROM project_feedback_widget_origin WHERE project_id = ? AND origin = ?",
    )
    .bind(projectId, origin)
    .first<{ present: number }>();
  return existing === null ? "too-many" : "added";
};

export const removeOrigin = async (
  db: D1Database,
  projectId: string,
  origin: string,
) => {
  await db
    .prepare(
      "DELETE FROM project_feedback_widget_origin WHERE project_id = ? AND origin = ?",
    )
    .bind(projectId, origin)
    .run();
};

export interface ClientWidget {
  readonly clientId: string;
  readonly projectId: string;
  /** `owner/name`, as the widget and its consent screen show the Project. */
  readonly projectLabel: string;
  readonly origins: ReadonlyArray<string>;
}

/** The turned-on widget a script address names, on a Project not deleted. */
export const readClientWidget = async (
  db: D1Database,
  clientId: string,
): Promise<ClientWidget | undefined> => {
  const row = await db
    .prepare(
      `SELECT widget.project_id, project.name AS project_name,
              COALESCE(workspace.name, owner.name) AS owner_name
         FROM project_feedback_widget AS widget
         JOIN projects AS project ON project.id = widget.project_id
         LEFT JOIN organization AS workspace ON workspace.id = project.workspace_id
         LEFT JOIN "user" AS owner ON owner.id = project.owner_user_id
        WHERE widget.client_id = ? AND project.deleted_at IS NULL`,
    )
    .bind(clientId)
    .first<{
      project_id: string;
      project_name: string;
      owner_name: string | null;
    }>();
  if (row === null) return undefined;
  return {
    clientId,
    projectId: row.project_id,
    projectLabel:
      row.owner_name === null
        ? row.project_name
        : `${row.owner_name}/${row.project_name}`,
    origins: await readOrigins(db, row.project_id),
  };
};

/** Records a person's consent for the panel holding the challenge's verifier. */
export const recordAuthorization = async (
  db: D1Database,
  input: { challenge: string; clientId: string; userId: string },
) => {
  await db
    .prepare(
      `INSERT INTO feedback_widget_authorization
         (challenge, client_id, user_id, approved_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (challenge) DO NOTHING`,
    )
    .bind(
      input.challenge,
      input.clientId,
      input.userId,
      new Date().toISOString(),
    )
    .run();
};

/**
 * Claims a consent once, within its lifetime, and mints the grant the panel
 * keeps. Undefined while the person has not approved yet.
 */
export const claimAuthorization = async (
  db: D1Database,
  input: { challenge: string; widget: ClientWidget },
): Promise<{ token: string; userId: string } | undefined> => {
  const now = Date.now();
  const claimed = await db
    .prepare(
      `UPDATE feedback_widget_authorization SET claimed_at = ?1
        WHERE challenge = ?2 AND client_id = ?3 AND claimed_at IS NULL
          AND approved_at > ?4
        RETURNING user_id`,
    )
    .bind(
      new Date(now).toISOString(),
      input.challenge,
      input.widget.clientId,
      new Date(now - AUTHORIZATION_TTL_MS).toISOString(),
    )
    .first<{ user_id: string }>();
  if (claimed === null) return undefined;
  const token = newGrantToken();
  await db
    .prepare(
      `INSERT INTO feedback_widget_grant
         (token_sha256, client_id, project_id, user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      await sha256Hex(token),
      input.widget.clientId,
      input.widget.projectId,
      claimed.user_id,
      new Date(now).toISOString(),
    )
    .run();
  return { token, userId: claimed.user_id };
};

export interface GrantHolder {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
}

/** The person a widget token belongs to, while its grant stands. */
export const readGrant = async (
  db: D1Database,
  widget: ClientWidget,
  token: string,
): Promise<GrantHolder | undefined> => {
  if (!/^dxw_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const row = await db
    .prepare(
      `UPDATE feedback_widget_grant SET last_used_at = ?1
        WHERE token_sha256 = ?2 AND client_id = ?3 AND project_id = ?4
        RETURNING user_id,
          (SELECT name FROM "user" WHERE id = user_id) AS name,
          (SELECT email FROM "user" WHERE id = user_id) AS email`,
    )
    .bind(
      new Date().toISOString(),
      await sha256Hex(token),
      widget.clientId,
      widget.projectId,
    )
    .first<{ user_id: string; name: string | null; email: string | null }>();
  if (row === null) return undefined;
  return {
    userId: row.user_id,
    name: row.name ?? "",
    email: row.email ?? "",
  };
};

export const deleteGrant = async (db: D1Database, token: string) => {
  await db
    .prepare("DELETE FROM feedback_widget_grant WHERE token_sha256 = ?")
    .bind(await sha256Hex(token))
    .run();
};
