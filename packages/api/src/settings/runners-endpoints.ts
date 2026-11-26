import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  CreateRunnerPairingResponseSchema,
  ListRunnersResponseSchema,
  RemoveRunnerResponseSchema,
  RunnerMachineId,
  RunnerNotFoundResponseSchema,
  RunnersNotOfferedResponseSchema,
} from "./runners.js";

export const ListRunnersEndpoint = defineEndpoint({
  id: "settings.personal.runners.list",
  summary: "List the person's runners",
  method: "GET",
  path: "/v1/settings/personal/runners",
  success: ListRunnersResponseSchema,
  refusals: [{ status: 404, schema: RunnersNotOfferedResponseSchema }],
});

export const CreateRunnerPairingEndpoint = defineEndpoint({
  id: "settings.personal.runners.pair",
  summary: "Start pairing a runner",
  method: "POST",
  path: "/v1/settings/personal/runners/pairings",
  success: CreateRunnerPairingResponseSchema,
  successStatus: 201,
  refusals: [{ status: 404, schema: RunnersNotOfferedResponseSchema }],
});

export const RemoveRunnerEndpoint = defineEndpoint({
  id: "settings.personal.runners.remove",
  summary: "Remove a runner",
  method: "DELETE",
  path: "/v1/settings/personal/runners/:machineId",
  params: Schema.Struct({ machineId: RunnerMachineId }),
  success: RemoveRunnerResponseSchema,
  refusals: [
    { status: 404, schema: RunnerNotFoundResponseSchema },
    { status: 404, schema: RunnersNotOfferedResponseSchema },
  ],
});
