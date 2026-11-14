import { type PluginJobsData, PluginJobsResponseSchema } from "@dx/api";
import type { PluginId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { type PluginsTarget, request } from "../../../shared/api/client.js";
import { pluginBundlesBase } from "./plugin-bundle-queries.js";

/** A plugin's background jobs, from its Durable Object host. */

const jobsPath = (target: PluginsTarget, pluginId: PluginId) =>
  `${pluginBundlesBase(target)}/${encodeURIComponent(pluginId)}/jobs`;

export const pluginJobsKey = (target: PluginsTarget, pluginId: PluginId) =>
  ["plugin-jobs", target, pluginId] as const;

export const pluginJobsQueryOptions = (
  target: PluginsTarget,
  pluginId: PluginId,
) =>
  queryOptions({
    queryKey: pluginJobsKey(target, pluginId),
    queryFn: async ({ signal }) =>
      (
        await request(jobsPath(target, pluginId), PluginJobsResponseSchema, {
          signal,
        })
      ).data,
    staleTime: 10_000,
    // Next runs move while the dialog is open; the object answers without D1.
    refetchInterval: 30_000,
  });

export const pluginJobActionMutationOptions = (
  queryClient: QueryClient,
  target: PluginsTarget,
  pluginId: PluginId,
) =>
  mutationOptions({
    mutationFn: async (input: {
      readonly action: "stop" | "start";
      readonly jobId: string;
      readonly threadId?: string;
    }): Promise<PluginJobsData> =>
      (
        await request(
          `${jobsPath(target, pluginId)}/${encodeURIComponent(input.jobId)}/${input.action}`,
          PluginJobsResponseSchema,
          {
            method: "POST",
            body: JSON.stringify(
              input.threadId === undefined ? {} : { threadId: input.threadId },
            ),
          },
        )
      ).data,
    onSuccess: (next) =>
      queryClient.setQueryData(pluginJobsKey(target, pluginId), next),
  });
