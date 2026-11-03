import type { ThreadId } from "@dx/domain";
import { Effect } from "effect";
import type { Bindings } from "../http/types.js";
import {
  type ExecutionEnvironmentRevision,
  environmentRevisionFrom,
  environmentRevisionStatements,
  resolveExecutionEnvironmentRevision,
} from "../settings/environment-variables/execution.js";

/** How long an authorization's revision stands in for a command's own read. */
const AUTHORIZED_REVISION_MS = 2_000;

/**
 * Revisions that authorizations read, by Thread, in this isolate. Each is
 * taken at most once and only while fresh, so a command's environment check
 * never compares against anything older than its own authorization.
 */
const authorizedRevisions = new Map<
  string,
  { readonly at: number; readonly revision: ExecutionEnvironmentRevision }
>();

/**
 * That the Thread is still active, as every agent command and Orb start
 * checks before it runs, read in the same D1 round trip as the environment
 * revision the command's environment check compares next. Two serial round
 * trips become one; the refusal is unchanged. A revision that fails to read
 * never affects authorization: the check then reads its own, as before.
 */
export const authorizeActiveThread = async (
  db: D1Database,
  threadId: string,
  /**
   * More statements for the same transaction, such as a conditional Changes
   * lease that writes nothing unless the Thread is active.
   */
  also: ReadonlyArray<D1PreparedStatement> = [],
): Promise<ReadonlyArray<D1Result | undefined>> => {
  authorizedRevisions.delete(threadId);
  const revisionStatements = environmentRevisionStatements(
    db,
    threadId as ThreadId,
  );
  const [lifecycle, ...rest] = await db.batch([
    db
      .prepare("SELECT lifecycle_state FROM threads WHERE id = ? LIMIT 1")
      .bind(threadId),
    ...revisionStatements,
    ...also,
  ]);
  const revision = rest.slice(0, revisionStatements.length);
  const row = lifecycle?.results[0] as
    | { readonly lifecycle_state?: unknown }
    | undefined;
  if (row?.lifecycle_state !== "active")
    throw new Error("Thread is not active.");
  try {
    const now = Date.now();
    for (const [id, entry] of authorizedRevisions)
      if (now - entry.at >= AUTHORIZED_REVISION_MS)
        authorizedRevisions.delete(id);
    authorizedRevisions.set(threadId, {
      at: now,
      revision: environmentRevisionFrom(revision),
    });
  } catch {
    // The environment check reads the revision itself.
  }
  return rest.slice(revisionStatements.length);
};

/**
 * The environment revision a command's check compares: the one its
 * authorization just read, or a fresh read.
 */
export const commandEnvironmentRevision = (
  bindings: Bindings,
  threadId: ThreadId,
): Promise<ExecutionEnvironmentRevision> => {
  const authorized = authorizedRevisions.get(threadId);
  authorizedRevisions.delete(threadId);
  if (
    authorized !== undefined &&
    Date.now() - authorized.at < AUTHORIZED_REVISION_MS
  )
    return Promise.resolve(authorized.revision);
  return Effect.runPromise(
    resolveExecutionEnvironmentRevision(bindings, threadId),
  );
};
