import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  createPluginTrigger,
  retryPluginTriggerDelivery,
  revokePluginTrigger,
  rotatePluginTrigger,
  updatePluginTriggerState,
} from "../../../shared/api/client.js";
import { triggerKeys } from "./triggers-queries.js";

export type TriggersMutationAction =
  | {
      readonly type: "updateState";
      readonly triggerId: Parameters<typeof updatePluginTriggerState>[0];
      readonly status: Parameters<typeof updatePluginTriggerState>[1];
    }
  | {
      readonly type: "revoke";
      readonly triggerId: Parameters<typeof revokePluginTrigger>[0];
    }
  | {
      readonly type: "retryDelivery";
      readonly triggerId: Parameters<typeof retryPluginTriggerDelivery>[0];
      readonly deliveryId: Parameters<typeof retryPluginTriggerDelivery>[1];
    };

export type TriggerCapabilityAction =
  | {
      readonly type: "create";
      readonly input: Parameters<typeof createPluginTrigger>[0];
    }
  | {
      readonly type: "rotate";
      readonly triggerId: Parameters<typeof rotatePluginTrigger>[0];
    };

export type OneTimeTriggerCapability = Awaited<
  ReturnType<typeof createPluginTrigger>
>["capability"];

const mutateTriggers = async (action: TriggersMutationAction) => {
  switch (action.type) {
    case "updateState":
      return await updatePluginTriggerState(action.triggerId, action.status);
    case "revoke":
      return await revokePluginTrigger(action.triggerId);
    case "retryDelivery":
      return await retryPluginTriggerDelivery(
        action.triggerId,
        action.deliveryId,
      );
  }
};

export const triggersMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...triggerKeys.list(userId), "mutate"],
    mutationFn: mutateTriggers,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: triggerKeys.list(userId) }),
  });

export const triggerCapabilityMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...triggerKeys.list(userId), "capability"],
    mutationFn: async (action: TriggerCapabilityAction) =>
      action.type === "create"
        ? await createPluginTrigger(action.input)
        : await rotatePluginTrigger(action.triggerId),
    gcTime: 0,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: triggerKeys.list(userId) }),
  });
