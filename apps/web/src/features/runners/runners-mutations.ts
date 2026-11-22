import {
  RemoveRunnerResponseSchema,
  type RunnerMachineId,
  RunnersUnavailableResponseSchema,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { request } from "../../shared/api/client.js";
import { runnerKeys, runnersBase } from "./runners-queries.js";

const removeRunner = async (machineId: RunnerMachineId) =>
  (
    await request(
      `${runnersBase}/${encodeURIComponent(machineId)}`,
      RemoveRunnerResponseSchema,
      { method: "DELETE" },
      RunnersUnavailableResponseSchema,
    )
  ).data;

export const removeRunnerMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...runnerKeys.all(userId), "remove"],
    gcTime: 0,
    mutationFn: (machineId: RunnerMachineId) => removeRunner(machineId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: runnerKeys.list(userId) }),
  });
