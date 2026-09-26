import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  applyBulkEnvironmentVariables,
  createEnvironmentVariable,
  deleteEnvironmentVariable,
  previewBulkEnvironmentVariables,
  rotateEnvironmentVariable,
  updateEnvironmentVariable,
} from "../../../shared/api/client.js";
import {
  type EnvironmentVariablesTarget,
  environmentVariableKeys,
} from "./environment-variables-queries.js";

export type EnvironmentVariablesMutationAction =
  | {
      readonly type: "update";
      readonly item: Parameters<typeof updateEnvironmentVariable>[1];
      readonly input: Parameters<typeof updateEnvironmentVariable>[2];
    }
  | {
      readonly type: "rotate";
      readonly item: Parameters<typeof rotateEnvironmentVariable>[1];
      readonly value: string;
    }
  | {
      readonly type: "delete";
      readonly item: Parameters<typeof deleteEnvironmentVariable>[1];
    }
  | {
      readonly type: "applyBulk";
      readonly input: Parameters<typeof applyBulkEnvironmentVariables>[1];
    };

const mutateEnvironmentVariables = async (
  target: EnvironmentVariablesTarget,
  action: EnvironmentVariablesMutationAction,
) => {
  switch (action.type) {
    case "update":
      return await updateEnvironmentVariable(target, action.item, action.input);
    case "rotate":
      return await rotateEnvironmentVariable(target, action.item, action.value);
    case "delete":
      return await deleteEnvironmentVariable(target, action.item);
    case "applyBulk":
      return await applyBulkEnvironmentVariables(target, action.input);
  }
};

export const environmentVariablesMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: EnvironmentVariablesTarget,
) =>
  mutationOptions({
    mutationKey: [...environmentVariableKeys.scope(userId, target), "mutate"],
    mutationFn: (action: EnvironmentVariablesMutationAction) =>
      mutateEnvironmentVariables(target, action),
    gcTime: 0,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: environmentVariableKeys.scope(userId, target),
      }),
  });

export const createEnvironmentVariableMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: EnvironmentVariablesTarget,
) =>
  mutationOptions({
    mutationKey: [...environmentVariableKeys.scope(userId, target), "create"],
    mutationFn: (input: Parameters<typeof createEnvironmentVariable>[1]) =>
      createEnvironmentVariable(target, input),
    gcTime: 0,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: environmentVariableKeys.scope(userId, target),
      }),
  });

export const environmentVariablesPreviewMutationOptions = (
  userId: UserId,
  target: EnvironmentVariablesTarget,
) =>
  mutationOptions({
    mutationKey: [...environmentVariableKeys.scope(userId, target), "preview"],
    mutationFn: (
      input: Parameters<typeof previewBulkEnvironmentVariables>[1],
    ) => previewBulkEnvironmentVariables(target, input),
    gcTime: 0,
    // Preview is non-authoritative and does not change server state.
    onSuccess: () => undefined,
  });
