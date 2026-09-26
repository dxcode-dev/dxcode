import type {
  CreateExternalApiApplicationRequest,
  ExternalApiApplicationSecretData,
  UpdateExternalApiApplicationRequest,
} from "@dx/api";
import type {
  ExternalApiApplicationId,
  ExternalApiApplicationRotationOverlapSeconds,
  UserId,
  WorkspaceSlug,
} from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  createExternalApiApplication,
  revokeExternalApiApplication,
  rotateExternalApiApplication,
  setExternalApiApplicationEnabled,
  updateExternalApiApplication,
} from "../../../shared/api/client.js";
import { applicationKeys } from "./application-queries.js";

type ApplicationMutation =
  | {
      readonly kind: "create";
      readonly input: CreateExternalApiApplicationRequest;
    }
  | {
      readonly kind: "update";
      readonly applicationId: ExternalApiApplicationId;
      readonly input: UpdateExternalApiApplicationRequest;
    }
  | {
      readonly kind: "rotate";
      readonly applicationId: ExternalApiApplicationId;
      readonly overlapSeconds: ExternalApiApplicationRotationOverlapSeconds;
    }
  | {
      readonly kind: "enabled";
      readonly applicationId: ExternalApiApplicationId;
      readonly enabled: boolean;
    }
  | {
      readonly kind: "revoke";
      readonly applicationId: ExternalApiApplicationId;
    };

export interface ApplicationMutationResult {
  readonly secret?: ExternalApiApplicationSecretData;
}

export const applicationMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  workspaceSlug: WorkspaceSlug,
) =>
  mutationOptions({
    mutationKey: [
      ...applicationKeys.all(userId, workspaceSlug),
      "mutate",
    ] as const,
    mutationFn: async (
      mutation: ApplicationMutation,
    ): Promise<ApplicationMutationResult> => {
      switch (mutation.kind) {
        case "create":
          return {
            secret: await createExternalApiApplication(
              workspaceSlug,
              mutation.input,
            ),
          };
        case "update":
          await updateExternalApiApplication(
            workspaceSlug,
            mutation.applicationId,
            mutation.input,
          );
          return {};
        case "rotate":
          return {
            secret: await rotateExternalApiApplication(
              workspaceSlug,
              mutation.applicationId,
              mutation.overlapSeconds,
            ),
          };
        case "enabled":
          await setExternalApiApplicationEnabled(
            workspaceSlug,
            mutation.applicationId,
            mutation.enabled,
          );
          return {};
        case "revoke":
          await revokeExternalApiApplication(
            workspaceSlug,
            mutation.applicationId,
          );
          return {};
      }
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: applicationKeys.all(userId, workspaceSlug),
      }),
    gcTime: 0,
  });
