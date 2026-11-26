import type {
  CreateConnectionRequestSchema,
  UpdateConnectionRequestSchema,
} from "@dx/api";
import {
  CreatePersonalModelConnectionEndpoint,
  CreateWorkspaceModelConnectionEndpoint,
  DeletePersonalModelConnectionEndpoint,
  DeleteWorkspaceModelConnectionEndpoint,
  ReorderPersonalModelConnectionsEndpoint,
  ReorderWorkspaceModelConnectionsEndpoint,
  SetPersonalClaudePlanExtraUsageEndpoint,
  SetPersonalModelConnectionEnabledEndpoint,
  SetWorkspaceClaudePlanExtraUsageEndpoint,
  SetWorkspaceModelConnectionEnabledEndpoint,
  UpdatePersonalModelConnectionEndpoint,
  UpdateWorkspaceModelConnectionEndpoint,
} from "@dx/api";
import type { ModelConnectionId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  ApiError,
  beginGitHubCopilotAuthorization,
  disconnectPersonalModelSubscription,
  dxClient,
  type ModelRoutingTarget,
  pollPersonalModelSubscriptionAuthorization,
} from "../../../shared/api/client.js";
import {
  checkModelConnectionAccess,
  connectionParams,
} from "./model-connection-queries.js";
import { modelRoutingKey } from "./model-routing-queries.js";

const createModelConnection = async (
  target: ModelRoutingTarget,
  input: typeof CreateConnectionRequestSchema.Encoded,
) =>
  (target.scope === "personal"
    ? await dxClient.call(CreatePersonalModelConnectionEndpoint, {
        body: input,
      })
    : await dxClient.call(CreateWorkspaceModelConnectionEndpoint, {
        params: { workspaceSlug: target.workspaceSlug },
        body: input,
      })
  ).data;

const updateModelConnection = async (
  target: ModelRoutingTarget,
  connectionId: string,
  input: typeof UpdateConnectionRequestSchema.Encoded,
) =>
  (target.scope === "personal"
    ? await dxClient.call(UpdatePersonalModelConnectionEndpoint, {
        params: connectionParams(connectionId),
        body: input,
      })
    : await dxClient.call(UpdateWorkspaceModelConnectionEndpoint, {
        params: {
          workspaceSlug: target.workspaceSlug,
          ...connectionParams(connectionId),
        },
        body: input,
      })
  ).data;

const setModelConnectionEnabled = async (
  target: ModelRoutingTarget,
  connectionId: string,
  enabled: boolean,
) =>
  (target.scope === "personal"
    ? await dxClient.call(SetPersonalModelConnectionEnabledEndpoint, {
        params: connectionParams(connectionId),
        body: { enabled },
      })
    : await dxClient.call(SetWorkspaceModelConnectionEnabledEndpoint, {
        params: {
          workspaceSlug: target.workspaceSlug,
          ...connectionParams(connectionId),
        },
        body: { enabled },
      })
  ).data;

const setClaudePlanExtraUsage = async (
  target: ModelRoutingTarget,
  connectionId: string,
  allowExtraUsage: boolean,
) =>
  (target.scope === "personal"
    ? await dxClient.call(SetPersonalClaudePlanExtraUsageEndpoint, {
        params: connectionParams(connectionId),
        body: { allowExtraUsage },
      })
    : await dxClient.call(SetWorkspaceClaudePlanExtraUsageEndpoint, {
        params: {
          workspaceSlug: target.workspaceSlug,
          ...connectionParams(connectionId),
        },
        body: { allowExtraUsage },
      })
  ).data;

const deleteModelConnection = async (
  target: ModelRoutingTarget,
  connectionId: string,
) =>
  (target.scope === "personal"
    ? await dxClient.call(DeletePersonalModelConnectionEndpoint, {
        params: connectionParams(connectionId),
      })
    : await dxClient.call(DeleteWorkspaceModelConnectionEndpoint, {
        params: {
          workspaceSlug: target.workspaceSlug,
          ...connectionParams(connectionId),
        },
      })
  ).data;

const reorderModelConnections = async (
  target: ModelRoutingTarget,
  orderedIds: ReadonlyArray<string>,
) => {
  const body = {
    orderedIds: orderedIds.map((id) => id as ModelConnectionId),
  };
  return (
    target.scope === "personal"
      ? await dxClient.call(ReorderPersonalModelConnectionsEndpoint, { body })
      : await dxClient.call(ReorderWorkspaceModelConnectionsEndpoint, {
          params: { workspaceSlug: target.workspaceSlug },
          body,
        })
  ).data;
};

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
  setClaudeExtraUsage: {
    mutationFn: (input: { connectionId: string; allowExtraUsage: boolean }) =>
      setClaudePlanExtraUsage(
        target,
        input.connectionId,
        input.allowExtraUsage,
      ),
    // Pending until the connections show the saved choice.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: modelRoutingKey(target) }),
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
