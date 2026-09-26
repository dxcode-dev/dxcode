import type { UserId, WorkspaceSlug } from "@dx/domain";
import { settingsKeys } from "../settings-context-queries.js";

export const workspaceKeys = {
  all: (userId: UserId) => [...settingsKeys.all(userId), "workspace"] as const,
  detail: (userId: UserId, workspaceSlug: WorkspaceSlug) =>
    [...workspaceKeys.all(userId), workspaceSlug] as const,
};
