import type {
  SidebarGrouping,
  SidebarLayoutChoice,
  SidebarLayoutData,
  SidebarOrder,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
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
 * Records one choice: a parent or section opened or closed, the Sidebar
 * Layout, or the Sidebar Order. Choices run one at a time, so each response holds
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
    mutationFn: (choice: SidebarLayoutChoice) => putSidebarLayoutEntry(choice),
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

/**
 * How the sidebar lists Threads: grouped by Project or in one list (Sidebar
 * Layout), by last activity or creation (Sidebar Order).
 */
export interface SidebarArrangement {
  readonly grouping: SidebarGrouping;
  readonly order: SidebarOrder;
}

/** The latest Sidebar Layout and Order among `choices`, or the defaults. */
export const arrangementFrom = (
  choices: ReadonlyArray<SidebarLayoutChoice>,
): SidebarArrangement => {
  let grouping: SidebarGrouping = "project";
  let order: SidebarOrder = "activity";
  for (const choice of choices) {
    if (choice.kind === "grouping") grouping = choice.grouping;
    else if (choice.kind === "order") order = choice.order;
  }
  return { grouping, order };
};

/** The saved layout as choices, applied in order: later ones win. */
const savedChoices = (
  saved: SidebarLayoutData | undefined,
): ReadonlyArray<SidebarLayoutChoice> =>
  saved === undefined
    ? []
    : [
        ...saved.entries,
        ...(saved.grouping === undefined
          ? []
          : [{ kind: "grouping" as const, grouping: saved.grouping }]),
        ...(saved.order === undefined
          ? []
          : [{ kind: "order" as const, order: saved.order }]),
      ];

/**
 * What the server holds with every choice not yet saved applied on top, so
 * a choice shows at once and no refetch can undo it; and a way to make one.
 */
export const useSyncedSidebarChoices = (userId: UserId) => {
  const queryClient = useQueryClient();
  const saved = useQuery(sidebarLayoutQueryOptions(userId)).data;
  const pending = useMutationState({
    filters: {
      mutationKey: sidebarLayoutKeys.update(userId),
      status: "pending",
    },
    select: (mutation) => mutation.state.variables as SidebarLayoutChoice,
  });
  const { mutate } = useMutation(
    updateSidebarLayoutMutationOptions(queryClient, userId),
  );
  // Reads the cache when called rather than when rendered, so handlers that
  // memoized rows receive stay correct.
  const current = () => [
    ...savedChoices(
      queryClient.getQueryData(sidebarLayoutQueryOptions(userId).queryKey),
    ),
    ...queryClient
      .getMutationCache()
      .findAll({
        mutationKey: sidebarLayoutKeys.update(userId),
        status: "pending",
      })
      .map((mutation) => mutation.state.variables as SidebarLayoutChoice),
  ];
  return {
    choices: [...savedChoices(saved), ...pending],
    current,
    choose: mutate,
  };
};

/** The person's Sidebar Layout and Order, and a way to change each. */
export const useSidebarArrangement = (
  userId: UserId,
): SidebarArrangement & {
  readonly setGrouping: (grouping: SidebarGrouping) => void;
  readonly setOrder: (order: SidebarOrder) => void;
} => {
  const { choices, choose } = useSyncedSidebarChoices(userId);
  return {
    ...arrangementFrom(choices),
    setGrouping: (grouping) => choose({ kind: "grouping", grouping }),
    setOrder: (order) => choose({ kind: "order", order }),
  };
};
