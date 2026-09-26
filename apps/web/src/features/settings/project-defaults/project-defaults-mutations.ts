import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  updatePersonalProjectDefaults,
  updateWorkspaceProjectDefaults,
} from "../../../shared/api/client.js";
import {
  type ProjectDefaultsTarget,
  projectDefaultsKeys,
} from "./project-defaults-queries.js";

export interface ProjectDefaultsMutationInput {
  readonly expectedRevision: number;
  readonly overrides: Parameters<typeof updatePersonalProjectDefaults>[1];
  readonly policy?: Parameters<typeof updateWorkspaceProjectDefaults>[3];
}

export const projectDefaultsMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: ProjectDefaultsTarget,
) =>
  mutationOptions({
    mutationKey: [...projectDefaultsKeys.detail(userId, target), "update"],
    mutationFn: ({
      expectedRevision,
      overrides,
      policy,
    }: ProjectDefaultsMutationInput) =>
      target.scope === "personal"
        ? updatePersonalProjectDefaults(expectedRevision, overrides)
        : updateWorkspaceProjectDefaults(
            target.workspaceSlug,
            expectedRevision,
            overrides,
            policy ?? {
              allowMemberProjectCreation: true,
              allowPublicCodeAccess: false,
              allowedRunnerProfileIds: null,
            },
          ),
    onSuccess: async (saved) => {
      await queryClient.cancelQueries({
        queryKey: projectDefaultsKeys.detail(userId, target),
        exact: true,
      });
      queryClient.setQueryData(
        projectDefaultsKeys.detail(userId, target),
        saved,
      );
    },
  });
