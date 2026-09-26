import type { SettingsContextData, WorkspaceProfileData } from "@dx/api";
import type { UserId, WorkspaceSlug } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  createWorkspace,
  updateWorkspaceProfile,
} from "../../../shared/api/client.js";
import { settingsKeys } from "../settings-context-queries.js";
import { workspaceKeys } from "./workspace-queries.js";

export type WorkspaceMutation =
  | {
      readonly kind: "create";
      readonly input: {
        readonly displayName: string;
        readonly shortName: string;
      };
    }
  | {
      readonly kind: "update";
      readonly workspaceSlug: WorkspaceSlug;
      readonly input: {
        readonly displayName: string;
        readonly shortName: string;
        readonly expectedRevision: number;
      };
    };

export const workspaceMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...workspaceKeys.all(userId), "mutate"] as const,
    mutationFn: (mutation: WorkspaceMutation) =>
      mutation.kind === "create"
        ? createWorkspace(mutation.input)
        : updateWorkspaceProfile(mutation.workspaceSlug, mutation.input),
    onSuccess: async (workspace: WorkspaceProfileData) => {
      const detailKey = workspaceKeys.detail(userId, workspace.shortName);
      const contextKey = settingsKeys.context(userId, {
        scope: "workspace",
        workspaceSlug: workspace.shortName,
      });
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey, exact: true }),
        queryClient.cancelQueries({ queryKey: contextKey, exact: true }),
      ]);
      queryClient.setQueryData(detailKey, workspace);
      queryClient.setQueryData<SettingsContextData>(contextKey, {
        activeScope: "workspace",
        workspace,
      });
      void queryClient.invalidateQueries({
        queryKey: settingsKeys.contexts(userId),
      });
    },
  });
