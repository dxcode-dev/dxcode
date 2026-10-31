import type { SidebarLayoutData, SidebarLayoutEntry } from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  getSidebarLayout,
  putSidebarCollapsed,
  putSidebarLayoutEntry,
  putSidebarWidth,
} from "../../shared/api/client.js";

export const sidebarLayoutKeys = {
  layout: (userId: UserId) => ["sidebar-layout", userId] as const,
  update: (userId: UserId) => ["sidebar-layout", userId, "update"] as const,
  width: (userId: UserId) => ["sidebar-layout", userId, "width"] as const,
  collapsed: (userId: UserId) =>
    ["sidebar-layout", userId, "collapsed"] as const,
};

/** Writes to the layout run one at a time, choices and width alike. */
const updateScope = (userId: UserId) =>
  sidebarLayoutKeys.update(userId).join(":");

const replaceLayout = async (
  queryClient: QueryClient,
  userId: UserId,
  layout: SidebarLayoutData,
) => {
  // A refetch that started before this write would undo it.
  await queryClient.cancelQueries({
    queryKey: sidebarLayoutKeys.layout(userId),
  });
  queryClient.setQueryData(sidebarLayoutKeys.layout(userId), layout);
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
    scope: { id: updateScope(userId) },
    mutationFn: (entry: SidebarLayoutEntry) => putSidebarLayoutEntry(entry),
    onSuccess: (layout: SidebarLayoutData) =>
      replaceLayout(queryClient, userId, layout),
    onError: () => invalidateSidebarLayout(queryClient, userId),
  });

/**
 * Records the width the person dragged the desktop sidebar to. The sidebar
 * already shows it, and reads the saved width only when it mounts.
 */
export const updateSidebarWidthMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: sidebarLayoutKeys.width(userId),
    scope: { id: updateScope(userId) },
    mutationFn: (width: number) => putSidebarWidth(width),
    onSuccess: (layout: SidebarLayoutData) =>
      replaceLayout(queryClient, userId, layout),
  });

/**
 * Records whether the desktop sidebar is collapsed. The sidebar already
 * shows it, and reads the saved state only when it mounts.
 */
export const updateSidebarCollapsedMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: sidebarLayoutKeys.collapsed(userId),
    scope: { id: updateScope(userId) },
    mutationFn: (collapsed: boolean) => putSidebarCollapsed(collapsed),
    onSuccess: (layout: SidebarLayoutData) =>
      replaceLayout(queryClient, userId, layout),
  });
