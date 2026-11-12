import {
  PROJECTLESS_PROJECT_NAME,
  type ThreadModelSelection,
  type UserId,
} from "@dx/domain";

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
  /**
   * The Thread's Project is the owner's repository-less one (No Project),
   * so a child it starts is projectless too.
   */
  readonly projectless: boolean;
  /** The Thread is a Space: the children it starts record who asked. */
  readonly space: boolean;
}

/** Reads the calling Thread; every Thread tool acts as its owner. */
export const readCallingThread = async (
  db: D1Database,
  threadId: string,
): Promise<CallingThread> => {
  const row = await db
    .prepare(
      `SELECT t.owner_user_id, t.project_id, t.model_selection,
         t.parent_thread_id, t.workspace_access, t.kind,
         p.name = ? AND p.owner_user_id = t.owner_user_id AS projectless
       FROM threads t LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.id = ? LIMIT 1`,
    )
    .bind(PROJECTLESS_PROJECT_NAME, threadId)
    .first<{
      owner_user_id: string;
      project_id: string;
      model_selection: string;
      parent_thread_id: string | null;
      workspace_access: string | null;
      kind: string | null;
      projectless: number | null;
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
    projectless: row.projectless === 1,
    space: row.kind === "space",
  };
};
