/**
 * SQL predicate: the user is a member of the workspace and the workspace is
 * active. Both arguments are trusted SQL expressions (column references or
 * bound parameter placeholders), never user input.
 */
export const activeMemberSql = (workspaceId: string, userId: string) => `
  EXISTS (
    SELECT 1 FROM member
      JOIN organization ON organization.id = member.organizationId
     WHERE member.organizationId = ${workspaceId}
       AND member.userId = ${userId}
       AND organization.lifecycleState = 'active')`;

/**
 * SQL predicate: a Thread owner reaches the Thread's Project, which is their
 * private Project or a Project of a workspace they actively belong to.
 */
export const threadProjectReachableSql = (
  project: string,
  threadOwnerId: string,
) => `(
  (${project}.workspace_id IS NULL AND ${project}.owner_user_id = ${threadOwnerId})
  OR (${project}.workspace_id IS NOT NULL
    AND ${activeMemberSql(`${project}.workspace_id`, threadOwnerId)}))`;
