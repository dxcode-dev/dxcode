import { SIDEBAR_WIDTH_MAX_PX, SIDEBAR_WIDTH_MIN_PX } from "@dx/api";
import type { UserId } from "@dx/domain";
import {
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import * as React from "react";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels";
import {
  sidebarLayoutQueryOptions,
  updateSidebarCollapsedMutationOptions,
  updateSidebarWidthMutationOptions,
} from "./sidebar-layout-queries.js";

/** The desktop sidebar's width until the person resizes it. */
export const SIDEBAR_DEFAULT_WIDTH_PX = 256;

/** The `id` of the desktop sidebar's panel in the product shell's group. */
export const SIDEBAR_PANEL_ID = "product-navigation";

/**
 * Loads what the shell reads as it mounts: the person's sidebar layout, which
 * holds the width they last dragged the sidebar to. The product route awaits
 * it so the sidebar opens at that width. It tries once: a failed load opens
 * at the default width at once, and the sidebar's own query retries.
 */
export const ensureProductShellData = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  queryClient
    .ensureQueryData({ ...sidebarLayoutQueryOptions(userId), retry: false })
    .then(
      () => undefined,
      () => undefined,
    );

/**
 * The desktop sidebar's width and whether it is collapsed, kept in the
 * person's sidebar layout as Thread pane sizes are kept in the Thread's
 * layout. Both are read once, as the panel takes its size when it mounts: a
 * change from another device shows on the next load.
 *
 * `onLayoutChanged` saves a width the person dragged or keyed the sidebar
 * to; a collapse is not a width, so `width()` stays what the sidebar reopens
 * at. `onCollapsedChange` saves a collapse or reopen however it happened.
 */
export function useSavedSidebarPanel(userId: UserId, mobile: boolean) {
  const queryClient = useQueryClient();
  const [saved] = React.useState(() => {
    const layout = queryClient.getQueryData(
      sidebarLayoutQueryOptions(userId).queryKey,
    );
    return {
      width: layout?.width ?? SIDEBAR_DEFAULT_WIDTH_PX,
      collapsed: layout?.collapsed === true,
    };
  });
  const widthRef = React.useRef(saved.width);
  const collapsedRef = React.useRef(saved.collapsed);
  const groupRef = React.useRef<HTMLDivElement>(null);
  const saveWidth = useMutation(
    updateSidebarWidthMutationOptions(queryClient, userId),
  ).mutate;
  const saveCollapsed = useMutation(
    updateSidebarCollapsedMutationOptions(queryClient, userId),
  ).mutate;
  // The panel's own size still holds the previous layout here, so the width
  // comes from the new layout's share of the group.
  const onLayoutChanged = (layout: Layout, meta: LayoutChangedMeta) => {
    const group = groupRef.current;
    const share = layout[SIDEBAR_PANEL_ID];
    if (!meta.isUserInteraction || mobile || group === null) return;
    if (share === undefined) return;
    const width = Math.round((share / 100) * group.clientWidth);
    if (
      width < SIDEBAR_WIDTH_MIN_PX ||
      width > SIDEBAR_WIDTH_MAX_PX ||
      width === widthRef.current
    )
      return;
    widthRef.current = width;
    saveWidth(width);
  };
  const onCollapsedChange = (collapsed: boolean) => {
    // A phone hides the panel and shows the sidebar as a drawer instead.
    if (mobile || collapsed === collapsedRef.current) return;
    collapsedRef.current = collapsed;
    saveCollapsed(collapsed);
  };
  /** The sidebar's share of the group at the width it reopens at. */
  const expandedGrow = () => {
    const groupWidth = groupRef.current?.clientWidth ?? 0;
    return groupWidth === 0
      ? "20"
      : String((widthRef.current / groupWidth) * 100);
  };
  return {
    defaultSize: saved.collapsed ? "0px" : `${saved.width}px`,
    startsCollapsed: saved.collapsed,
    width: () => widthRef.current,
    expandedGrow,
    groupRef,
    onLayoutChanged,
    onCollapsedChange,
  };
}
