import { RemoveRunnerEndpoint, type RunnerMachineId } from "@dx/api";
import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";
import { runnerKeys } from "./runners-queries.js";

const removeRunner = async (machineId: RunnerMachineId) =>
  (await dxClient.call(RemoveRunnerEndpoint, { params: { machineId } })).data;

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
