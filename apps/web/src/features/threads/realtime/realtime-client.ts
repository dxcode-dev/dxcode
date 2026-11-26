import {
  type RealtimeClock,
  RealtimeConnection,
  type RealtimeHints,
  type RealtimeSocket,
} from "@dx/client";
import type { UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import { reportSessionEnded } from "../../../shared/auth/session-ended.js";
import { recordConnectionEvent } from "../../../shared/diagnostics/client-diagnostics.js";
import {
  invalidateAllArtifacts,
  invalidateArtifactLibrary,
  invalidateArtifacts,
} from "../../artifacts/artifacts-queries.js";
import { invalidateMailbox } from "../../mailbox/mailbox-cache-queries.js";
import { invalidateSidebarLayout } from "../../navigation/sidebar-layout-queries.js";
import { invalidateNotifications } from "../../notifications/notifications-queries.js";
import {
  invalidateAllMessageComments,
  invalidateMessageComments,
} from "../../spaces/comments/message-comments-cache-queries.js";
import {
  invalidateSpaceArtifacts,
  invalidateSpaceForThread,
  invalidateSpacePosts,
  invalidateSpaceQueries,
} from "../../spaces/space-cache-queries.js";
import {
  invalidateAllThreadAutomations,
  invalidateThreadAutomations,
} from "../automations/automations-queries.js";
import {
  invalidateAllChanges,
  invalidateChangesRanges,
} from "../changes/changes-queries.js";
import { invalidateThreadFileTrees } from "../files/files-queries.js";
import {
  invalidateAllOrbDisk,
  invalidateOrbDisk,
} from "../orb-disk/orb-disk-cache-queries.js";
import {
  invalidateAllOrbMemory,
  invalidateOrbMemory,
} from "../orb-memory/orb-memory-cache-queries.js";
import { invalidateMessageReactions } from "../sharing/message-reactions-cache-queries.js";
import {
  invalidateAllThreadQueries,
  invalidatePluginPaneMessages,
  invalidatePluginUi,
  invalidateReadinessQuery,
} from "../thread-queries.js";
import { ThreadListRows } from "../thread-row-queries.js";

const invalidateAllRealtimeState = (
  queryClient: QueryClient,
  userId: UserId,
) => {
  void invalidateAllThreadQueries(queryClient, userId);
  void invalidateAllChanges(queryClient);
  void invalidateAllOrbMemory(queryClient);
  void invalidateAllOrbDisk(queryClient);
  void invalidateAllThreadAutomations(queryClient);
  void invalidateAllArtifacts(queryClient);
  void invalidateMailbox(queryClient, userId);
  void invalidateNotifications(queryClient, userId);
  void invalidateSidebarLayout(queryClient, userId);
  void invalidateSpaceQueries(queryClient, userId);
  void invalidateAllMessageComments(queryClient, userId);
};

const visible = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

/** Browser timers, read when called so a test's fake timers apply. */
const browserClock: RealtimeClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * What each realtime hint refreshes in the web's Query cache. The protocol
 * (cursor, gaps, reconnect, presence, typing) lives in `RealtimeConnection`.
 */
const queryHints = (
  queryClient: QueryClient,
  userId: UserId,
  rows: ThreadListRows,
): RealtimeHints => ({
  resync: () => invalidateAllRealtimeState(queryClient, userId),
  joined: (threadId) => rows.threadChanged(threadId),
  hint: (event) => {
    switch (event.type) {
      case "thread.invalidated":
        rows.threadChanged(event.threadId);
        void invalidateThreadAutomations(queryClient, event.threadId);
        void invalidateSpaceForThread(queryClient, userId, event.threadId);
        return;
      case "readiness.invalidated":
        void invalidateReadinessQuery(queryClient, userId, event.threadId);
        return;
      case "changes.invalidated":
        void invalidateChangesRanges(queryClient, event.threadId);
        void invalidateThreadFileTrees(queryClient, event.threadId);
        rows.changesChanged(event.threadId, event.summaryChanged === true);
        return;
      case "memory.invalidated":
        void invalidateOrbMemory(queryClient, event.threadId);
        return;
      case "artifacts.invalidated":
        void invalidateArtifacts(queryClient, event.threadId);
        void invalidateSpaceArtifacts(queryClient, userId, event.threadId);
        return;
      case "artifact.invalidated":
        void invalidateArtifacts(queryClient, `artifact:${event.artifactId}`);
        void invalidateArtifactLibrary(queryClient);
        return;
      case "plugin-ui.invalidated":
        void invalidatePluginUi(queryClient, event.threadId);
        return;
      case "plugin-pane.invalidated":
        void invalidatePluginPaneMessages(queryClient, event.threadId);
        return;
      case "space.posts.invalidated":
        void invalidateSpacePosts(queryClient, userId, event.threadId);
        return;
      case "reactions.invalidated":
        void invalidateMessageReactions(queryClient, userId, event.threadId);
        return;
      case "comments.invalidated":
        void invalidateMessageComments(queryClient, userId, event.threadId);
        return;
      case "disk.invalidated":
        void invalidateOrbDisk(queryClient, event.threadId);
        return;
      case "notifications.invalidated":
        void invalidateNotifications(queryClient, userId);
        return;
      case "mailbox.invalidated":
        void invalidateMailbox(queryClient, userId);
        return;
      case "sidebar.invalidated":
        void invalidateSidebarLayout(queryClient, userId);
        void invalidateSpaceQueries(queryClient, userId);
        return;
    }
  },
});

/**
 * The web's realtime connection: `RealtimeConnection` with browser sockets,
 * timers, and page visibility, whose hints refresh the Query cache.
 */
export class RealtimeClient extends RealtimeConnection {
  readonly #rows: ThreadListRows;

  constructor(
    queryClient: QueryClient,
    userId: UserId,
    socketFactory: (url: string) => RealtimeSocket = (url) =>
      new WebSocket(url),
  ) {
    const rows = new ThreadListRows(queryClient, userId);
    super({
      userId,
      clientId: crypto.randomUUID(),
      origin: window.location.href,
      createSocket: socketFactory,
      clock: browserClock,
      hints: queryHints(queryClient, userId, rows),
      isVisible: visible,
      onSessionEnded: reportSessionEnded,
      onConnectionEvent: recordConnectionEvent,
    });
    this.#rows = rows;
  }

  override start() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.#onVisibility);
      window.addEventListener("pagehide", this.#onPageHide);
      window.addEventListener("pageshow", this.#onVisibility);
    }
    super.start();
  }

  override stop() {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.#onVisibility);
      window.removeEventListener("pagehide", this.#onPageHide);
      window.removeEventListener("pageshow", this.#onVisibility);
    }
    this.#rows.stop();
    super.stop();
  }

  readonly #onVisibility = () => this.visibilityChanged();
  readonly #onPageHide = () => this.leaving();
}
