import type {
  CreateConnectionRequestSchema,
  UpdateConnectionRequestSchema,
} from "@dx/api";
import type { QueryClient } from "@tanstack/react-query";
import {
  ApiError,
  beginGitHubCopilotAuthorization,
  checkModelConnectionAccess,
  createModelConnection,
  deleteModelConnection,
  disconnectPersonalModelSubscription,
  type ModelRoutingTarget,
  pollPersonalModelSubscriptionAuthorization,
  reorderModelConnections,
  setModelConnectionEnabled,
  updateModelConnection,
} from "../../../shared/api/client.js";
import { modelRoutingKey } from "./model-routing-queries.js";

const invalidate = (queryClient: QueryClient, target: ModelRoutingTarget) => {
  void queryClient.invalidateQueries({ queryKey: modelRoutingKey(target) });
  void queryClient.invalidateQueries({
    queryKey: ["model-routing", "personal", "choices"],
  });
  void queryClient.invalidateQueries({
    queryKey: ["model-routing", "personal", "profile"],
  });
  void queryClient.invalidateQueries({
    queryKey: ["model-routing", "personal", "subscriptions"],
  });
};

/** Broad invalidation for flows (Copilot connect) that cross scopes. */
export const invalidateAllModelRouting = (queryClient: QueryClient) => {
  void queryClient.invalidateQueries({ queryKey: ["model-routing"] });
};

/** GitHub Copilot device-flow begin — used by the connect dialog. */
export const beginCopilotAuthorization = () =>
  beginGitHubCopilotAuthorization();

/** GitHub Copilot device-flow poll — used by the connect dialog. */
export const pollCopilotAuthorization = (authorizationId: string) =>
  pollPersonalModelSubscriptionAuthorization(authorizationId);

export const apiMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Request failed.";

export const fieldErrorsOf = (error: unknown): Record<string, string> =>
  error instanceof ApiError
    ? Object.fromEntries(
        (error.fieldErrors ?? []).map(({ field, message }) => [field, message]),
      )
    : {};

export const connectionMutationOptions = (
  queryClient: QueryClient,
  target: ModelRoutingTarget,
) => ({
  create: {
    mutationFn: (input: typeof CreateConnectionRequestSchema.Encoded) =>
      createModelConnection(target, input),
    onSettled: () => invalidate(queryClient, target),
  },
  update: {
    mutationFn: (input: {
      connectionId: string;
      patch: typeof UpdateConnectionRequestSchema.Encoded;
    }) => updateModelConnection(target, input.connectionId, input.patch),
    onSettled: () => invalidate(queryClient, target),
  },
  setEnabled: {
    mutationFn: (input: { connectionId: string; enabled: boolean }) =>
      setModelConnectionEnabled(target, input.connectionId, input.enabled),
    onSettled: () => invalidate(queryClient, target),
  },
  reorder: {
    mutationFn: (orderedIds: ReadonlyArray<string>) =>
      reorderModelConnections(target, orderedIds),
    onSettled: () => invalidate(queryClient, target),
  },
  checkAccess: {
    mutationFn: (connectionId: string) =>
      checkModelConnectionAccess(target, connectionId),
    onSettled: () => invalidate(queryClient, target),
  },
  remove: {
    mutationFn: (connectionId: string) =>
      deleteModelConnection(target, connectionId),
    onSettled: () => invalidate(queryClient, target),
  },
  disconnectSubscription: {
    mutationFn: (connectionId: string) =>
      disconnectPersonalModelSubscription(connectionId),
    onSettled: () => invalidate(queryClient, target),
  },
});
