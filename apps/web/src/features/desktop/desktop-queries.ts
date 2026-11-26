import {
  ActOnThreadDesktopWindowsEndpoint,
  GetThreadDesktopEndpoint,
  ListThreadDesktopWindowsEndpoint,
  type MacDesktopPermissions,
  type MacSettingsPane,
  OpenThreadDesktopSettingsEndpoint,
  type ThreadDesktopSettingsData,
  ThreadDesktopSocketEndpoint,
  type ThreadDesktopWindowsAction,
  type ThreadDesktopWindowsData,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { ApiError, dxClient, endpointPath } from "../../shared/api/client.js";

/** The Desktop's WebSocket path, `/v1/threads/:threadId/desktop/ws`. */
export const desktopSocketPath = (threadId: ThreadId) =>
  endpointPath(ThreadDesktopSocketEndpoint, {
    params: { threadId, channel: "ws" },
  });

export type DesktopAvailability =
  /** `notice`: a Mac runner's Desktop streams but says what is off (input). */
  | {
      readonly kind: "ready";
      readonly notice?: string;
      /** A Mac runner's Desktop: view-only until control is turned on. */
      readonly startsViewOnly?: boolean;
    }
  | { readonly kind: "unsupported" }
  /**
   * A Mac runner whose macOS has not allowed dx to record the screen yet:
   * which permissions are missing, and the runner's words with voxl's log.
   */
  | {
      readonly kind: "permissions";
      readonly permissions: MacDesktopPermissions;
      readonly detail?: string;
    }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Starts the Thread's desktop through Core and says whether it can stream.
 * Each call is an action (it may wake the workspace and start the desktop),
 * so the viewer runs it on connect and retry rather than caching it. A
 * desktop that has not answered within one start's time limit is asked
 * once more before it counts as failed: an Orb just resumed from a disk
 * snapshot (Boat) can take longer to start it, and a second start waits for
 * that same session instead of starting another.
 */
export const checkDesktop = async (
  threadId: ThreadId,
  signal: AbortSignal,
): Promise<DesktopAvailability> => {
  try {
    const check = () =>
      dxClient.call(
        GetThreadDesktopEndpoint,
        { params: { threadId } },
        { signal },
      );
    let { data } = await check();
    // A runner's answer is already its final one: asking again would only
    // repeat it (and a missing voxl would be looked for twice).
    if (data.desktop === "unavailable" && data.detail === undefined)
      ({ data } = await check());
    if (data.desktop === "ready")
      return {
        kind: "ready",
        ...(data.detail === undefined ? {} : { notice: data.detail }),
        ...(data.startsViewOnly === true ? { startsViewOnly: true } : {}),
      };
    if (data.desktop === "unsupported") return { kind: "unsupported" };
    if (data.permissions?.screenRecording === false)
      return {
        kind: "permissions",
        permissions: data.permissions,
        ...(data.detail === undefined ? {} : { detail: data.detail }),
      };
    // A Mac runner says why: voxl missing (with its build command), macOS
    // permissions, or the Mac offline.
    return {
      kind: "failed",
      message: data.detail ?? "The desktop didn't start.",
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409)
      return {
        kind: "failed",
        message: "Unarchive the Thread to use its desktop.",
      };
    if (error instanceof ApiError && error.status === 403)
      return {
        kind: "failed",
        message: "Only contributors can use the desktop.",
      };
    return { kind: "failed", message: "The desktop couldn't be reached." };
  }
};

/**
 * Opens System Settings on a Mac runner at a privacy pane, so the person
 * allows dx there. `opened: false` carries why (the Mac offline).
 */
export const openDesktopSettings = async (
  threadId: ThreadId,
  pane: MacSettingsPane,
): Promise<ThreadDesktopSettingsData> =>
  (
    await dxClient.call(OpenThreadDesktopSettingsEndpoint, {
      params: { threadId },
      body: { pane },
    })
  ).data;

export const desktopSettingsMutation = (threadId: ThreadId) =>
  mutationOptions({
    mutationFn: (pane: MacSettingsPane) => openDesktopSettings(threadId, pane),
  });

/**
 * The Desktop's windows, for the app row. Listing never starts the desktop
 * or wakes the workspace; an action answers with the windows after it.
 */
export const desktopWindowsQueryKey = (threadId: ThreadId) =>
  ["thread-desktop-windows", threadId] as const;

export const listDesktopWindows = async (
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<ThreadDesktopWindowsData> =>
  (
    await dxClient.call(
      ListThreadDesktopWindowsEndpoint,
      { params: { threadId } },
      { ...(signal === undefined ? {} : { signal }) },
    )
  ).data;

export const actOnDesktopWindows = async (
  threadId: ThreadId,
  action: ThreadDesktopWindowsAction,
): Promise<ThreadDesktopWindowsData> =>
  (
    await dxClient.call(ActOnThreadDesktopWindowsEndpoint, {
      params: { threadId },
      body: action,
    })
  ).data;

/** Windows opened or closed inside the desktop show within this long. */
export const DESKTOP_WINDOWS_POLL_MS = 10_000;

/** The windows of a live Desktop, listed again every 10 s while it is. */
export const desktopWindowsQueryOptions = (threadId: ThreadId, live: boolean) =>
  queryOptions({
    queryKey: desktopWindowsQueryKey(threadId),
    queryFn: ({ signal }) => listDesktopWindows(threadId, signal),
    enabled: live,
    refetchInterval: live ? DESKTOP_WINDOWS_POLL_MS : false,
    staleTime: 0,
    retry: false,
  });

/** Opens, focuses, or reopens a window; its answer is the new window list. */
export const desktopWindowsActionMutation = (
  queryClient: QueryClient,
  threadId: ThreadId,
) =>
  mutationOptions({
    mutationFn: (action: ThreadDesktopWindowsAction) =>
      actOnDesktopWindows(threadId, action),
    onSuccess: (data) => {
      queryClient.setQueryData<ThreadDesktopWindowsData>(
        desktopWindowsQueryKey(threadId),
        data,
      );
    },
  });

/** After a click or key on the desktop, which may close a window. */
const DESKTOP_WINDOWS_SETTLE_MS = 700;
/**
 * After the desktop's first picture: a desktop that just started (a new
 * Orb, or one that woke from a stop) maps its Terminal and Chromium over the
 * next few seconds, after the first listing.
 */
const DESKTOP_WINDOWS_START_MS = [2_000, 5_000, 9_000];

const invalidateWindows = (queryClient: QueryClient, threadId: ThreadId) =>
  void queryClient.invalidateQueries({
    queryKey: desktopWindowsQueryKey(threadId),
    exact: true,
  });

const settling = new Map<ThreadId, ReturnType<typeof setTimeout>>();

/**
 * Lists the windows again once input on the desktop settles: a click on a
 * window's close button, Alt+F4, Ctrl+W, or `exit` and Return may have
 * closed one.
 */
export const refreshDesktopWindowsSoon = (
  queryClient: QueryClient,
  threadId: ThreadId,
) => {
  clearTimeout(settling.get(threadId));
  settling.set(
    threadId,
    setTimeout(() => {
      settling.delete(threadId);
      invalidateWindows(queryClient, threadId);
    }, DESKTOP_WINDOWS_SETTLE_MS),
  );
};

/**
 * Lists the windows a few more times after the desktop's first picture,
 * while a desktop that just started opens its apps.
 */
export const refreshDesktopWindowsAfterStart = (
  queryClient: QueryClient,
  threadId: ThreadId,
) => {
  for (const delay of DESKTOP_WINDOWS_START_MS)
    setTimeout(() => invalidateWindows(queryClient, threadId), delay);
};

/**
 * The desktop surface's handlers that list the windows again after input
 * that may close one: any click, and Return or a key with Ctrl, Alt, or
 * Meta.
 */
export const desktopWindowInputHandlers = (
  queryClient: QueryClient,
  threadId: ThreadId,
) => ({
  onPointerUpCapture: () => refreshDesktopWindowsSoon(queryClient, threadId),
  onKeyUpCapture: (event: {
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
  }) => {
    if (event.key === "Enter" || event.ctrlKey || event.altKey || event.metaKey)
      refreshDesktopWindowsSoon(queryClient, threadId);
  },
});
