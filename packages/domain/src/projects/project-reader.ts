import type { Principal } from "../auth/principal.js";
import type { WorkspaceId } from "../settings/workspace.js";
import type { UserId } from "../users/user-id.js";

/**
 * Whose Projects, and the Threads in them, a request reaches. A person
 * reaches their private Projects and their active workspace's. An External
 * API App acts for its creator inside its own workspace only: never the
 * creator's private Projects, and nothing once the creator leaves it.
 */
export interface ProjectReader {
  readonly userId: UserId;
  readonly workspaceId?: WorkspaceId;
}

export const projectReaderOf = (principal: Principal): ProjectReader =>
  principal.application === undefined
    ? { userId: principal.userId }
    : {
        userId: principal.userId,
        workspaceId: principal.application.workspaceId,
      };
