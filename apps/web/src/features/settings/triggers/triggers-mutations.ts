import {
  CreatePluginTriggerEndpoint,
  RetryPluginTriggerDeliveryEndpoint,
  RevokePluginTriggerEndpoint,
  RotatePluginTriggerEndpoint,
  UpdatePluginTriggerStateEndpoint,
} from "@dx/api";
import type {
  EnvironmentVariableConfigReference,
  PluginCapabilityName,
  PluginId,
  PluginTriggerDeliveryId,
  PluginTriggerId,
  PluginVersion,
  UserId,
} from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";
import { triggerKeys } from "./triggers-queries.js";

const createPluginTrigger = async (input: {
  readonly pluginId: PluginId;
  readonly pluginVersion: PluginVersion;
  readonly capabilityName: PluginCapabilityName;
  readonly hmacSecretReference?: EnvironmentVariableConfigReference;
}) => (await dxClient.call(CreatePluginTriggerEndpoint, { body: input })).data;

const updatePluginTriggerState = async (
  triggerId: PluginTriggerId,
  status: "active" | "paused",
) =>
  (
    await dxClient.call(UpdatePluginTriggerStateEndpoint, {
      params: { triggerId },
      body: { status },
    })
  ).data;

const rotatePluginTrigger = async (triggerId: PluginTriggerId) =>
  (
    await dxClient.call(RotatePluginTriggerEndpoint, {
      params: { triggerId },
      body: {},
    })
  ).data;

const revokePluginTrigger = async (triggerId: PluginTriggerId) =>
  (await dxClient.call(RevokePluginTriggerEndpoint, { params: { triggerId } }))
    .data.revokedTriggerId;

const retryPluginTriggerDelivery = async (
  triggerId: PluginTriggerId,
  deliveryId: PluginTriggerDeliveryId,
) =>
  (
    await dxClient.call(RetryPluginTriggerDeliveryEndpoint, {
      params: { triggerId, deliveryId },
      body: {},
    })
  ).data;

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
