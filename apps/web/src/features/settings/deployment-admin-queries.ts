import { GetDeploymentAdminStatusEndpoint } from "@dx/api";
import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";

/** Whether the person administers this deployment; the server decides. */
export const deploymentAdminQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: ["deployment-admin", userId] as const,
    queryFn: async ({ signal }) =>
      (await dxClient.call(GetDeploymentAdminStatusEndpoint, {}, { signal }))
        .data.admin,
    staleTime: 60_000,
  });
