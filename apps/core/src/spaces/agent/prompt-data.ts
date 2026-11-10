import { PROJECTLESS_PROJECT_NAME } from "@dx/domain";
import type { Bindings } from "../../http/types.js";
import { displayNameSql } from "../../thread-sharing/service.js";
import { dxOrigin, threadUrl } from "../posts/effects.js";
import type {
  SpacePromptProject,
  SpaceSystemPromptInput,
} from "./system-prompt.js";

/**
 * The Space's Project as its prompt and setup message describe it: its
 * name and repository URLs, or null for a Space without a Project (its
 * owner's No Project).
 */
export const readSpaceProject = async (
  db: D1Database,
  spaceThreadId: string,
): Promise<SpacePromptProject | null | undefined> => {
  const [project, repositories] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT project.name,
                project.name = ?2 AND project.owner_user_id = thread.owner_user_id
                  AS projectless
           FROM threads AS thread
           JOIN projects AS project ON project.id = thread.project_id
          WHERE thread.id = ?1`,
      )
      .bind(spaceThreadId, PROJECTLESS_PROJECT_NAME),
    db
      .prepare(
        `SELECT web_url FROM (
           SELECT repository.web_url, -1 AS position
             FROM threads AS thread
             JOIN project_repository AS repository
               ON repository.project_id = thread.project_id
            WHERE thread.id = ?1
           UNION ALL
           SELECT additional.web_url, additional.position
             FROM threads AS thread
             JOIN project_additional_repository AS additional
               ON additional.project_id = thread.project_id
            WHERE thread.id = ?1)
          ORDER BY position`,
      )
      .bind(spaceThreadId),
  ]);
  const row = project?.results[0] as
    | { name: string; projectless: number | null }
    | undefined;
  if (row === undefined) return undefined;
  if (row.projectless === 1) return null;
  return {
    name: row.name,
    repositories: (
      (repositories?.results ?? []) as Array<{ web_url: string }>
    ).map(({ web_url }) => web_url),
  };
};

/** What a Space's prompt is built from, read for each submission. */
export const readSpaceAgentPromptData = async (
  db: D1Database,
  bindings: Bindings,
  spaceThreadId: string,
): Promise<SpaceSystemPromptInput | undefined> => {
  const row = await db
    .prepare(
      `SELECT thread.title, space.goal,
              ${displayNameSql("owner", "account")} AS owner_name
         FROM threads AS thread
         JOIN "user" AS owner ON owner.id = thread.owner_user_id
         LEFT JOIN personal_account AS account ON account.user_id = owner.id
         LEFT JOIN space ON space.thread_id = thread.id
        WHERE thread.id = ?1 AND thread.kind = 'space'`,
    )
    .bind(spaceThreadId)
    .first<{ title: string; goal: string | null; owner_name: string | null }>();
  if (row === null) return undefined;
  const [project, origin] = await Promise.all([
    readSpaceProject(db, spaceThreadId),
    dxOrigin(bindings),
  ]);
  return {
    spaceName: row.title,
    goal: row.goal === null || row.goal.trim() === "" ? null : row.goal,
    project: project ?? null,
    threadUrl: threadUrl(origin, spaceThreadId),
    origin,
    ownerName: row.owner_name?.trim() || "the owner",
  };
};
