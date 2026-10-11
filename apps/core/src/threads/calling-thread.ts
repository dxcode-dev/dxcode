import type { ThreadModelSelection, UserId } from "@dx/domain";

/** The Thread whose agent calls a Thread tool, and whom the call acts as. */
export interface CallingThread {
  readonly id: string;
  readonly ownerUserId: UserId;
  readonly projectId: string;
  readonly selection: ThreadModelSelection | undefined;
  /**
   * While the calling Thread is shared with the workspace, the root of its
   * family: the tools reach only that root and its children, never the
   * owner's other private Threads.
   */
  readonly sharedFamilyRoot?: string;
}

/** Reads the calling Thread; every Thread tool acts as its owner. */
export const readCallingThread = async (
  db: D1Database,
  threadId: string,
): Promise<CallingThread> => {
  const row = await db
    .prepare(
      `SELECT owner_user_id, project_id, model_selection, parent_thread_id,
         workspace_access
       FROM threads WHERE id = ? LIMIT 1`,
    )
    .bind(threadId)
    .first<{
      owner_user_id: string;
      project_id: string;
      model_selection: string;
      parent_thread_id: string | null;
      workspace_access: string | null;
    }>();
  if (row === null) throw new Error("This Thread is unavailable.");
  let selection: ThreadModelSelection | undefined;
  try {
    selection = JSON.parse(row.model_selection) as ThreadModelSelection;
  } catch {
    selection = undefined;
  }
  const shared =
    row.workspace_access !== null && row.workspace_access !== "none";
  return {
    id: threadId,
    ownerUserId: row.owner_user_id as UserId,
    projectId: row.project_id,
    selection,
    ...(shared ? { sharedFamilyRoot: row.parent_thread_id ?? threadId } : {}),
  };
};
