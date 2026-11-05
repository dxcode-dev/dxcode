import { createTwoFilesPatch } from "diff";
import { wrapPeopleText } from "./people-text.js";
import {
  type ArtifactBindings,
  type ArtifactWithMarkdown,
  readArtifactRevision,
} from "./store.js";

/** The most of a people diff the agent gets, before it is cut. */
const PEOPLE_DIFF_CHARS = 12_000;

type EditsContext = {
  readonly db: D1Database;
  readonly bindings: ArtifactBindings;
};

/** The newest kept revisions the agent and people saved. */
const newestRevisions = async (db: D1Database, artifactId: string) => {
  const row = await db
    .prepare(
      `SELECT MAX(revision) AS agent_revision,
              (SELECT MAX(revision) FROM thread_artifact_revision
                WHERE artifact_id = ?1 AND author_kind = 'user') AS person_revision
         FROM thread_artifact_revision
        WHERE artifact_id = ?1 AND author_kind = 'agent'`,
    )
    .bind(artifactId)
    .first<{ agent_revision: number | null; person_revision: number | null }>();
  return {
    agent: row?.agent_revision ?? null,
    person: row?.person_revision ?? null,
  };
};

/** The diff from kept revision `from` to the current one. */
const diffFrom = async (
  context: EditsContext,
  threadId: string,
  current: ArtifactWithMarkdown,
  from: number,
  label: string,
) => {
  const before = await readArtifactRevision(
    context.bindings,
    threadId,
    current.artifact.id,
    from,
  );
  if (before === undefined) return undefined;
  const patch = createTwoFilesPatch(
    `revision ${from} (${label})`,
    `revision ${current.artifact.revision} (current)`,
    before.markdown,
    current.markdown,
    undefined,
    undefined,
    { context: 2 },
  );
  return {
    from_revision: from,
    to_revision: current.artifact.revision,
    diff: wrapPeopleText(patch, PEOPLE_DIFF_CHARS),
  };
};

/**
 * What people changed since the agent's newest kept revision, as a unified
 * diff; undefined when no person saved after it or the agent never saved.
 */
export const editedByPeopleSince = async (
  context: EditsContext,
  threadId: string,
  current: ArtifactWithMarkdown,
) => {
  const newest = await newestRevisions(context.db, current.artifact.id);
  if (
    newest.agent === null ||
    newest.person === null ||
    newest.person <= newest.agent
  )
    return undefined;
  return diffFrom(context, threadId, current, newest.agent, "your last save");
};

/**
 * What a person's Notify agent tells the agent changed: people's edits since
 * the agent's last save, or, on an artifact the agent never saved, since it
 * was created. `edited` is undefined when there is nothing to compare.
 */
export const changesForAgent = async (
  context: EditsContext,
  threadId: string,
  current: ArtifactWithMarkdown,
) => {
  const newest = await newestRevisions(context.db, current.artifact.id);
  if (newest.agent !== null)
    return {
      agentSaved: true,
      edited:
        newest.person === null || newest.person <= newest.agent
          ? undefined
          : await diffFrom(
              context,
              threadId,
              current,
              newest.agent,
              "your last save",
            ),
    } as const;
  return {
    agentSaved: false,
    edited:
      current.artifact.revision <= 1
        ? undefined
        : await diffFrom(context, threadId, current, 1, "as created"),
  } as const;
};
