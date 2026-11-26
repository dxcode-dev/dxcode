import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  CreatePluginTriggerRequestSchema,
  CreatePluginTriggerResponseSchema,
  ListPluginTriggersResponseSchema,
  PluginTriggerConflictResponseSchema,
  PluginTriggerDeliveryParamsSchema,
  PluginTriggerForbiddenResponseSchema,
  PluginTriggerLimitResponseSchema,
  PluginTriggerNotFoundResponseSchema,
  PluginTriggerParamsSchema,
  PluginTriggersBrowserSessionRequiredResponseSchema,
  PluginTriggersInvalidRequestResponseSchema,
  PluginTriggersPolicyDeniedResponseSchema,
  PluginTriggersUnavailableResponseSchema,
  RetryPluginTriggerDeliveryResponseSchema,
  RevokePluginTriggerResponseSchema,
  RotatePluginTriggerResponseSchema,
  UpdatePluginTriggerStateRequestSchema,
  UpdatePluginTriggerStateResponseSchema,
} from "./plugin-triggers.js";

/**
 * The endpoints over `plugin-triggers.ts`. In their own module, so code that imports
 * only the schemas, such as the Thread page, does not carry them
 * (wiki/headless-client.md).
 */

const pluginTriggerRefusals = [
  { status: 400, schema: PluginTriggersInvalidRequestResponseSchema },
  { status: 404, schema: PluginTriggerNotFoundResponseSchema },
  { status: 403, schema: PluginTriggerForbiddenResponseSchema },
  { status: 403, schema: PluginTriggersPolicyDeniedResponseSchema },
  { status: 409, schema: PluginTriggerLimitResponseSchema },
  { status: 409, schema: PluginTriggerConflictResponseSchema },
  { status: 403, schema: PluginTriggersBrowserSessionRequiredResponseSchema },
  { status: 503, schema: PluginTriggersUnavailableResponseSchema },
];
const PluginTriggersPath = "/v1/settings/personal/triggers";

/** `rotate` and delivery `retry` take an empty JSON object. */
export const PluginTriggerEmptyRequestSchema = Schema.Struct({});

export const ListPluginTriggersEndpoint = defineEndpoint({
  id: "pluginTriggers.list",
  method: "GET",
  path: PluginTriggersPath,
  success: ListPluginTriggersResponseSchema,
  refusals: pluginTriggerRefusals,
});

export const CreatePluginTriggerEndpoint = defineEndpoint({
  id: "pluginTriggers.create",
  method: "POST",
  path: PluginTriggersPath,
  body: CreatePluginTriggerRequestSchema,
  success: CreatePluginTriggerResponseSchema,
  successStatus: 201,
  refusals: pluginTriggerRefusals,
});

export const UpdatePluginTriggerStateEndpoint = defineEndpoint({
  id: "pluginTriggers.updateState",
  method: "PATCH",
  path: `${PluginTriggersPath}/:triggerId`,
  params: PluginTriggerParamsSchema,
  body: UpdatePluginTriggerStateRequestSchema,
  success: UpdatePluginTriggerStateResponseSchema,
  refusals: pluginTriggerRefusals,
});

export const RotatePluginTriggerEndpoint = defineEndpoint({
  id: "pluginTriggers.rotate",
  method: "POST",
  path: `${PluginTriggersPath}/:triggerId/rotate`,
  params: PluginTriggerParamsSchema,
  body: PluginTriggerEmptyRequestSchema,
  success: RotatePluginTriggerResponseSchema,
  refusals: pluginTriggerRefusals,
});

export const RevokePluginTriggerEndpoint = defineEndpoint({
  id: "pluginTriggers.revoke",
  method: "DELETE",
  path: `${PluginTriggersPath}/:triggerId`,
  params: PluginTriggerParamsSchema,
  success: RevokePluginTriggerResponseSchema,
  refusals: pluginTriggerRefusals,
});

export const RetryPluginTriggerDeliveryEndpoint = defineEndpoint({
  id: "pluginTriggers.retryDelivery",
  method: "POST",
  path: `${PluginTriggersPath}/:triggerId/deliveries/:deliveryId/retry`,
  params: PluginTriggerDeliveryParamsSchema,
  body: PluginTriggerEmptyRequestSchema,
  success: RetryPluginTriggerDeliveryResponseSchema,
  refusals: pluginTriggerRefusals,
});
