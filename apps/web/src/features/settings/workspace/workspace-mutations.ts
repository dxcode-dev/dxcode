import type { SettingsContextData, WorkspaceProfileData } from "@dx/api";
import {
  CreateWorkspaceEndpoint,
  RemoveWorkspaceAvatarEndpoint,
  SetWorkspaceAvatarEndpoint,
  UpdateWorkspaceProfileEndpoint,
} from "@dx/api";
import type { UserId, WorkspaceSlug } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  deleteWorkspace,
  dxClient,
  leaveWorkspace,
} from "../../../shared/api/client.js";
import { settingsKeys } from "../settings-context-queries.js";
import { workspaceKeys } from "./workspace-queries.js";

const createWorkspace = async (input: {
  readonly displayName: string;
  readonly shortName: string;
}): Promise<WorkspaceProfileData> =>
  (await dxClient.call(CreateWorkspaceEndpoint, { body: input })).data;

const updateWorkspaceProfile = async (
  workspaceSlug: WorkspaceSlug,
  input: {
    readonly displayName: string;
    readonly shortName: string;
    readonly expectedRevision: number;
  },
): Promise<WorkspaceProfileData> =>
  (
    await dxClient.call(UpdateWorkspaceProfileEndpoint, {
      params: { workspaceSlug },
      body: input,
    })
  ).data;

/** Replaces the workspace's picture with `file`, or removes it with `null`. */
const setWorkspaceAvatar = async (
  workspaceSlug: WorkspaceSlug,
  file: File | null,
): Promise<WorkspaceProfileData> =>
  (file === null
    ? await dxClient.call(RemoveWorkspaceAvatarEndpoint, {
        params: { workspaceSlug },
      })
    : await dxClient.call(SetWorkspaceAvatarEndpoint, {
        params: { workspaceSlug },
        body: file,
      })
  ).data;

export type WorkspaceMutation =
  | {
      readonly kind: "create";
      readonly input: {
        readonly displayName: string;
        readonly shortName: string;
      };
    }
  | {
      readonly kind: "avatar";
      readonly workspaceSlug: WorkspaceSlug;
      readonly file: File | null;
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
        : mutation.kind === "avatar"
          ? setWorkspaceAvatar(mutation.workspaceSlug, mutation.file)
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

export const leaveWorkspaceMutationOptions = (
  workspaceSlug: WorkspaceSlug,
) => ({
  mutationFn: () => leaveWorkspace(workspaceSlug),
});

export const deleteWorkspaceMutationOptions = (
  workspaceSlug: WorkspaceSlug,
) => ({
  mutationFn: (input: {
    readonly confirmShortName: string;
    readonly threads: "keep" | "delete";
  }) => deleteWorkspace(workspaceSlug, input),
});
