import {
  ListThreadPortalsEndpoint,
  PublishThreadPortalEndpoint,
  RevokeThreadPortalEndpoint,
  type ThreadPortalPublicDuration,
  WakeThreadPortalsEndpoint,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";

export const portalKeys = {
  thread: (threadId: ThreadId) => ["thread-portals", threadId] as const,
};

/**
 * The Thread's guest listeners as Portal URLs. Listing never wakes a paused
 * workspace; it polls only while the Preview pane is showing the list.
 */
export const threadPortalsQueryOptions = (
  threadId: ThreadId,
  polling: boolean,
) =>
  queryOptions({
    queryKey: portalKeys.thread(threadId),
    queryFn: async ({ signal }) =>
      (
        await dxClient.call(
          ListThreadPortalsEndpoint,
          { params: { threadId } },
          { signal },
        )
      ).data,
    staleTime: 3_000,
    refetchInterval: polling ? 5_000 : false,
    refetchIntervalInBackground: false,
  });

/**
 * Resumes a paused workspace and lists its ports; the answer replaces the
 * cached list, which keeps polling as before.
 */
export const useWakePortals = (threadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...portalKeys.thread(threadId), "wake"],
    mutationFn: async () =>
      (
        await dxClient.call(WakeThreadPortalsEndpoint, {
          params: { threadId },
        })
      ).data,
    onSuccess: (data) => client.setQueryData(portalKeys.thread(threadId), data),
  });
};

const publicLinkParams = (threadId: ThreadId, port: number) => ({
  threadId,
  port: String(port),
});

/**
 * The owner makes a port public for a while, or private again. Either way
 * the list is refetched: it is the one owner of which ports are public.
 */
export const usePortalPublicLink = (threadId: ThreadId) => {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...portalKeys.thread(threadId), "public"],
    mutationFn: async (
      change:
        | {
            readonly port: number;
            readonly duration: ThreadPortalPublicDuration;
          }
        | { readonly port: number; readonly duration: "private" },
    ) =>
      change.duration === "private"
        ? dxClient.call(RevokeThreadPortalEndpoint, {
            params: publicLinkParams(threadId, change.port),
          })
        : dxClient.call(PublishThreadPortalEndpoint, {
            params: publicLinkParams(threadId, change.port),
            body: { duration: change.duration },
          }),
    onSettled: () =>
      client.invalidateQueries({ queryKey: portalKeys.thread(threadId) }),
  });
};
