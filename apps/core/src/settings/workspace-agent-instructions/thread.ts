/**
 * The AGENTS.md of the workspace a Thread runs in: its owner's active
 * workspace (a person belongs to at most one). Empty when the owner has no
 * workspace or the workspace has none. A failed read rejects, so the
 * submission fails visibly instead of running without the admin's guidance.
 */
export const loadThreadWorkspaceAgentInstructions = async (
  db: D1Database,
  threadId: string,
): Promise<string> => {
  const row = await db
    .prepare(
      `SELECT instructions.content
         FROM threads
         JOIN member ON member.userId = threads.owner_user_id
         JOIN organization ON organization.id = member.organizationId
                          AND organization.lifecycleState = 'active'
         JOIN workspace_agent_instructions AS instructions
           ON instructions.workspace_id = member.organizationId
        WHERE threads.id = ?`,
    )
    .bind(threadId)
    .first<{ content: string }>();
  return row?.content ?? "";
};
