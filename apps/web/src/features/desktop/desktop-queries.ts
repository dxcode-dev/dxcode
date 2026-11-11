import {
  GetThreadDesktopResponseSchema,
  GetThreadDesktopWindowsResponseSchema,
  type ThreadDesktopWindowsAction,
  type ThreadDesktopWindowsData,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { ApiError, request } from "../../shared/api/client.js";

export const desktopPath = (threadId: ThreadId) =>
  `/v1/threads/${encodeURIComponent(threadId)}/desktop`;

export type DesktopAvailability =
  | { readonly kind: "ready" }
  | { readonly kind: "unsupported" }
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
      request(desktopPath(threadId), GetThreadDesktopResponseSchema, {
        signal,
      });
    let { data } = await check();
    if (data.desktop === "unavailable") ({ data } = await check());
    if (data.desktop === "ready") return { kind: "ready" };
    if (data.desktop === "unsupported") return { kind: "unsupported" };
    return { kind: "failed", message: "The desktop didn't start." };
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
    await request(
      `${desktopPath(threadId)}/windows`,
      GetThreadDesktopWindowsResponseSchema,
      { signal: signal ?? null },
    )
  ).data;

export const actOnDesktopWindows = async (
  threadId: ThreadId,
  action: ThreadDesktopWindowsAction,
): Promise<ThreadDesktopWindowsData> =>
  (
    await request(
      `${desktopPath(threadId)}/windows`,
      GetThreadDesktopWindowsResponseSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      },
    )
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
