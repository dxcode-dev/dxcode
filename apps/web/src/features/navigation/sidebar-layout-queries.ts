import type { SidebarLayoutData, SidebarLayoutEntry } from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  getSidebarLayout,
  putSidebarLayoutEntry,
} from "../../shared/api/client.js";

export const sidebarLayoutKeys = {
  layout: (userId: UserId) => ["sidebar-layout", userId] as const,
  update: (userId: UserId) => ["sidebar-layout", userId, "update"] as const,
};

/**
 * The person's sidebar layout. Realtime `sidebar.invalidated` refetches it
 * when another device changes it; focus and reconnect cover a socket that
 * was down.
 */
export const sidebarLayoutQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: sidebarLayoutKeys.layout(userId),
    queryFn: ({ signal }) => getSidebarLayout(signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });

export const invalidateSidebarLayout = (client: QueryClient, userId: UserId) =>
  client.invalidateQueries({ queryKey: sidebarLayoutKeys.layout(userId) });

/**
 * Records one choice. Choices run one at a time, so each response holds
 * every earlier one; the sidebar shows a choice from the moment it is made
 * (see `useSidebarLayout`), so nothing waits on this request.
 */
export const updateSidebarLayoutMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: sidebarLayoutKeys.update(userId),
    scope: { id: sidebarLayoutKeys.update(userId).join(":") },
    mutationFn: (entry: SidebarLayoutEntry) => putSidebarLayoutEntry(entry),
    onSuccess: async (layout: SidebarLayoutData) => {
      // A refetch that started before this write would undo it.
      await queryClient.cancelQueries({
        queryKey: sidebarLayoutKeys.layout(userId),
      });
      queryClient.setQueryData(sidebarLayoutKeys.layout(userId), layout);
    },
    onError: () => invalidateSidebarLayout(queryClient, userId),
  });
