import {
  type EnvironmentVariableId,
  isHiddenEnvironmentValue,
  MASKED_SECRET_VALUE,
  type UserId,
} from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { DateTime } from "effect";
import {
  ApiError,
  applyBulkEnvironmentVariables,
  createEnvironmentVariable,
  deleteEnvironmentVariable,
  type listEnvironmentVariables,
  previewBulkEnvironmentVariables,
  rotateEnvironmentVariable,
  updateEnvironmentVariable,
} from "../../../shared/api/client.js";
import {
  type EnvironmentVariableData,
  type EnvironmentVariablesTarget,
  environmentVariableKeys,
} from "./environment-variables-queries.js";

type EnvironmentVariableList = Awaited<
  ReturnType<typeof listEnvironmentVariables>
>;

/** The list's order: by name, then by id. */
const byName = (
  left: EnvironmentVariableData,
  right: EnvironmentVariableData,
) =>
  left.name === right.name
    ? left.reference.id < right.reference.id
      ? -1
      : 1
    : left.name < right.name
      ? -1
      : 1;

/** Changes the cached list of values in place of a reread. */
const changeList = (
  queryClient: QueryClient,
  userId: UserId,
  target: EnvironmentVariablesTarget,
  change: (
    items: EnvironmentVariableList["items"],
  ) => EnvironmentVariableList["items"],
) =>
  queryClient.setQueryData<EnvironmentVariableList>(
    environmentVariableKeys.list(userId, target),
    (list) =>
      list === undefined ? list : { ...list, items: change(list.items) },
  );

/** A read that started before a save must not land after it. */
const holdReads = (
  queryClient: QueryClient,
  userId: UserId,
  target: EnvironmentVariablesTarget,
) =>
  queryClient.cancelQueries({
    queryKey: environmentVariableKeys.list(userId, target),
    exact: true,
  });

const sameItem =
  (item: EnvironmentVariableData) => (other: EnvironmentVariableData) =>
    other.reference.id === item.reference.id;

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

/** The server's field errors, or its message when it names no field. */
export const failureMessages = (
  error: unknown,
): ReadonlyArray<{ readonly field: string; readonly message: string }> => {
  const fieldErrors =
    error instanceof ApiError ? (error.fieldErrors ?? []) : [];
  return fieldErrors.length > 0
    ? fieldErrors
    : [
        {
          field: "request",
          message: error instanceof Error ? error.message : "Request failed.",
        },
      ];
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
    // Disabling, enabling, and deleting show at once; a failed save puts the
    // value back as it was, and callers show the error.
    onMutate: async (action) => {
      if (action.type !== "update" && action.type !== "delete") return;
      await holdReads(queryClient, userId, target);
      changeList(queryClient, userId, target, (items) =>
        action.type === "delete"
          ? items.filter((item) => !sameItem(action.item)(item))
          : items.map((item) =>
              sameItem(action.item)(item) ? { ...item, ...action.input } : item,
            ),
      );
    },
    onError: (_error, action) => {
      if (action.type !== "update" && action.type !== "delete") return;
      changeList(queryClient, userId, target, (items) =>
        items.some(sameItem(action.item))
          ? items.map((item) =>
              sameItem(action.item)(item) ? action.item : item,
            )
          : [...items, action.item].sort(byName),
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: environmentVariableKeys.scope(userId, target),
      }),
  });

export const createEnvironmentVariableMutationKey = (
  userId: UserId,
  target: EnvironmentVariablesTarget,
) => [...environmentVariableKeys.scope(userId, target), "create"] as const;

/**
 * The row a new value shows while it saves. A secret shows masked, so its
 * value stays only in the mutation, which is dropped once it settles.
 */
const pendingItem = (
  target: EnvironmentVariablesTarget,
  input: Parameters<typeof createEnvironmentVariable>[1],
): EnvironmentVariableData => {
  const now = DateTime.makeUnsafe(Date.now());
  return {
    reference: {
      version: 1,
      kind: "environment-variable",
      id: `pending_${crypto.randomUUID()}` as EnvironmentVariableId,
    },
    name: input.name as EnvironmentVariableData["name"],
    kind: input.kind,
    scope: target.scope,
    ...(target.scope === "project" ? { projectId: target.projectId } : {}),
    enabled: true,
    source: target.scope,
    value: input.kind === "secret" ? MASKED_SECRET_VALUE : input.value,
    hidden: isHiddenEnvironmentValue(input.kind, input.value),
    createdAt: now,
    updatedAt: now,
    rotatedAt: now,
  };
};

export const createEnvironmentVariableMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: EnvironmentVariablesTarget,
) =>
  mutationOptions({
    mutationKey: createEnvironmentVariableMutationKey(userId, target),
    mutationFn: (input: Parameters<typeof createEnvironmentVariable>[1]) =>
      createEnvironmentVariable(target, input),
    gcTime: 0,
    // The new row shows at once and becomes the saved one, or leaves if the
    // save fails.
    onMutate: async (input) => {
      await holdReads(queryClient, userId, target);
      const pending = pendingItem(target, input);
      changeList(queryClient, userId, target, (items) =>
        [...items, pending].sort(byName),
      );
      return { pending };
    },
    onSuccess: (created, _input, context) =>
      changeList(queryClient, userId, target, (items) =>
        items.map((item) =>
          context !== undefined && sameItem(context.pending)(item)
            ? created
            : item,
        ),
      ),
    onError: (_error, _input, context) => {
      if (context === undefined) return;
      changeList(queryClient, userId, target, (items) =>
        items.filter((item) => !sameItem(context.pending)(item)),
      );
    },
    onSettled: () =>
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
