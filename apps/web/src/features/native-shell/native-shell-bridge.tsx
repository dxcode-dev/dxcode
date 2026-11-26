import type { QueryClient } from "@tanstack/react-query";
import type { AppRouter } from "../../router.js";
import type { SignedInIdentity } from "../../shared/auth/auth-context.js";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import {
  type NativeShellCapability,
  nativeShell,
  onShellEvent,
} from "../../shared/native-shell/native-shell.js";
import { threadKeys } from "../threads/thread-queries.js";
import {
  newlyNeedingAttention,
  recentThreads,
  type ThreadAttention,
  threadsNeedingAttention,
} from "./thread-attention.js";
import { watchWindowDrag } from "./window-drag.js";

export { ShellHostsMenuGroup } from "./shell-hosts-menu-group.js";

const threadPath = (id: string) => `/threads/${id}`;

/** How many recent Threads the shell's menu bar list shows. */
const RECENT_THREADS = 8;

/** True while the person is looking at this Thread in the app's window. */
const watching = (id: string) =>
  document.hasFocus() && window.location.pathname === threadPath(id);

/**
 * Connects the signed-in app to the native shell hosting it: the Dock badge
 * counts unread Threads, a finished or failed turn the person is not
 * watching becomes a native notification, the menu bar lists recent Threads,
 * the page's top rows move the window, and notification clicks and deep
 * links route in place. Menu commands reach the command palette's commands
 * through `CommandProvider`. Loaded only inside a shell.
 */
export function NativeShellBridge({
  router,
  queryClient,
  identity,
}: {
  readonly router: AppRouter;
  readonly queryClient: QueryClient;
  readonly identity: SignedInIdentity;
}) {
  useMountEffect(() => {
    const shell = nativeShell();
    if (shell === undefined) return;
    const can = (capability: NativeShellCapability) =>
      shell.capabilities.includes(capability);

    const stopEvents = onShellEvent((event) => {
      if (event.type !== "navigate") return;
      const url = new URL(event.url, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (router.getMatchedRoutes(url.pathname)[2] === undefined) {
        window.location.assign(url.href);
        return;
      }
      void router.navigate({ href: url.pathname + url.search + url.hash });
    });

    let previous: ReadonlyMap<string, ThreadAttention> | undefined;
    let badge = -1;
    let recent = "";
    const sync = () => {
      const current = threadsNeedingAttention(queryClient);
      if (can("badge") && current.size !== badge) {
        badge = current.size;
        shell.post({ type: "badge", count: badge });
      }
      if (can("notify")) {
        for (const thread of newlyNeedingAttention(previous, current)) {
          if (watching(thread.id)) continue;
          shell.post({
            type: "notify",
            id: `${thread.id}:${thread.activity}`,
            title: thread.title,
            body: thread.failed
              ? "The turn ended with an error."
              : "Finished a turn.",
            url: threadPath(thread.id),
          });
        }
      }
      if (can("recent-threads")) {
        const items = recentThreads(queryClient, RECENT_THREADS);
        const key = JSON.stringify(items);
        if (key !== recent) {
          recent = key;
          shell.post({ type: "threads", items });
        }
      }
      // Lists load after the app does: the baseline is the first snapshot
      // that has any, so Threads already unread at launch never notify.
      if (previous !== undefined || hasThreadLists(queryClient))
        previous = current;
    };
    sync();
    const stopCache = queryClient.getQueryCache().subscribe((event) => {
      if (
        (event.type === "updated" || event.type === "removed") &&
        threadKeys.isList(event.query.queryKey)
      )
        sync();
    });
    const stopDrag = can("window-drag")
      ? watchWindowDrag((message) => shell.post(message))
      : undefined;
    shell.post({
      type: "ready",
      page: window.location.pathname,
      account: { name: identity.name, email: identity.email },
    });
    return () => {
      stopEvents();
      stopCache();
      stopDrag?.();
    };
  });
  return null;
}

const hasThreadLists = (client: QueryClient) =>
  client
    .getQueryCache()
    .getAll()
    .some(
      (query) =>
        threadKeys.isList(query.queryKey) && query.state.data !== undefined,
    );
