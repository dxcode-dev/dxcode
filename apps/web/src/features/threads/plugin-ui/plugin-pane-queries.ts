import {
  PluginPaneMessagesResponseSchema,
  PluginPaneViewResponseSchema,
  PluginThreadUiErrorResponseSchema,
  PostPluginPaneMessageResponseSchema,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { ApiError, request } from "../../../shared/api/client.js";
import { pluginPaneMessagesKey } from "../thread-queries.js";

/**
 * One installed plugin's pane in a Thread: its view, its kept posts (which
 * realtime's `plugin-pane.invalidated` refetches), and the messages its view
 * sends to the plugin. Loaded with the first pane shown.
 */

const panePath = (threadId: ThreadId, plugin: string, pane: string) =>
  `/v1/threads/${encodeURIComponent(threadId)}/plugin-ui/panes/${encodeURIComponent(plugin)}/${encodeURIComponent(pane)}`;

/**
 * Apart from the plugin UI's key, so a prompt or notice never refetches an
 * open pane's view; a new plugin version shows once it goes stale.
 */
export const pluginPaneViewQueryOptions = (
  threadId: ThreadId,
  plugin: string,
  pane: string,
) =>
  queryOptions({
    queryKey: ["plugin-pane-view", threadId, plugin, pane] as const,
    queryFn: async ({ signal }) =>
      (
        await request(
          panePath(threadId, plugin, pane),
          PluginPaneViewResponseSchema,
          { signal },
          PluginThreadUiErrorResponseSchema,
        )
      ).data,
    staleTime: 30_000,
    retry: (failures, error) => !isPluginPaneGone(error) && failures < 1,
  });

/** The pane's kept posts in the Thread, oldest first. */
export const pluginPaneMessagesQueryOptions = (
  threadId: ThreadId,
  plugin: string,
  pane: string,
) =>
  queryOptions({
    queryKey: [...pluginPaneMessagesKey(threadId), plugin, pane] as const,
    queryFn: async ({ signal }) =>
      (
        await request(
          `${panePath(threadId, plugin, pane)}/messages`,
          PluginPaneMessagesResponseSchema,
          { signal },
          PluginThreadUiErrorResponseSchema,
        )
      ).data.messages,
    staleTime: 30_000,
    retry: 1,
  });

/**
 * The pane is gone from the Thread: its plugin was turned off or removed, or
 * no longer offers it. The pane stops its view instead of letting it keep
 * calling a plugin that is not there.
 */
export class PluginPaneGoneError extends Error {
  override readonly name = "PluginPaneGoneError";
}

/** Whether a pane request failed because the pane no longer exists. */
export const isPluginPaneGone = (error: unknown) =>
  error instanceof PluginPaneGoneError ||
  (error instanceof ApiError && error.code === "PLUGIN_PANE_NOT_FOUND");

const errorDetail = (error: unknown) =>
  error !== null &&
  typeof error === "object" &&
  "data" in error &&
  typeof (error as { data?: { detail?: unknown } }).data?.detail === "string"
    ? (error as { data: { detail: string } }).data.detail
    : error instanceof Error
      ? error.message
      : "The plugin could not answer.";

/** A view's `dx/plugin.post`: runs the pane's `onMessage`; resolves its result. */
export const pluginPaneMessageMutationOptions = (
  threadId: ThreadId,
  plugin: string,
  pane: string,
) =>
  mutationOptions({
    mutationFn: async (message: unknown) => {
      try {
        return (
          await request(
            `${panePath(threadId, plugin, pane)}/messages`,
            PostPluginPaneMessageResponseSchema,
            { method: "POST", body: JSON.stringify({ message }) },
            PluginThreadUiErrorResponseSchema,
          )
        ).data.result;
      } catch (error) {
        if (isPluginPaneGone(error))
          throw new PluginPaneGoneError(errorDetail(error));
        throw new Error(errorDetail(error));
      }
    },
    // The pane is gone: reload its view, which then says so for good.
    onError: (error, _message, _result, context) => {
      if (isPluginPaneGone(error))
        void context.client.invalidateQueries({
          queryKey: pluginPaneViewQueryOptions(threadId, plugin, pane).queryKey,
        });
    },
  });
