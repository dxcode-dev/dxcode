/**
 * The workspace instructions a Thread started with: its owner's active
 * workspace's AGENTS.md, copied when the Thread was created
 * (`threads.workspace_agent_instructions`). An admin's later edit reaches new
 * Threads only, so an open Thread's prompt, and its prompt cache, stay as
 * they were. Empty when the owner had no workspace or the workspace had
 * none. A failed read rejects, so the submission fails visibly instead of
 * running without the admin's guidance.
 */
export const loadThreadWorkspaceAgentInstructions = async (
  db: D1Database,
  threadId: string,
): Promise<string> => {
  const row = await db
    .prepare(
      `SELECT workspace_agent_instructions AS content
         FROM threads
        WHERE id = ?`,
    )
    .bind(threadId)
    .first<{ content: string }>();
  return row?.content ?? "";
};
