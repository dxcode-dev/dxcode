import type { ThreadId, UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";
import { RealtimeClient, type ThreadTyping } from "./realtime-client.js";

const RealtimeContext = React.createContext<RealtimeClient | undefined>(
  undefined,
);

export function RealtimeProvider({
  queryClient,
  userId,
  children,
}: {
  readonly queryClient: QueryClient;
  readonly userId: UserId;
  readonly children: React.ReactNode;
}) {
  const [client] = React.useState(
    () => new RealtimeClient(queryClient, userId),
  );
  useMountEffect(() => {
    client.start();
    return () => client.stop();
  });
  return <RealtimeContext value={client}>{children}</RealtimeContext>;
}

const presenceSnapshot = () => undefined;

export const useThreadPresence = (threadId: ThreadId) => {
  const client = React.use(RealtimeContext);
  const subscribe = (_onStoreChange: () => void) =>
    client?.observeThread(threadId) ?? (() => undefined);
  React.useSyncExternalStore(subscribe, presenceSnapshot, presenceSnapshot);
};

export const useThreadWorkspaceStatus = (threadId: ThreadId) => {
  const client = React.use(RealtimeContext);
  const subscribe = (onStoreChange: () => void) =>
    client?.observeWorkspaceStatus(threadId, onStoreChange) ??
    (() => undefined);
  const snapshot = () => client?.workspaceStatus(threadId);
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
};

/** Users who have this Thread open now; subscribes without joining. */
export const useThreadPresentUsers = (threadId: ThreadId) => {
  const client = React.use(RealtimeContext);
  const subscribe = (onStoreChange: () => void) =>
    client?.observePresentUsers(threadId, onStoreChange) ?? (() => undefined);
  const snapshot = () => client?.presentUsers(threadId);
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
};

const NO_TYPING: ReadonlyArray<ThreadTyping> = [];

/** Who else is typing a comment on one of this Thread's messages now. */
export const useThreadTyping = (threadId: ThreadId) => {
  const client = React.use(RealtimeContext);
  const subscribe = (onStoreChange: () => void) =>
    client?.observeTyping(threadId, onStoreChange) ?? (() => undefined);
  const snapshot = () => client?.typing(threadId) ?? NO_TYPING;
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
};

/** Tells the others with the Thread open that the viewer is typing a comment. */
export const useSendThreadTyping = (threadId: ThreadId) => {
  const client = React.use(RealtimeContext);
  return (scope: string) => client?.sendTyping(threadId, scope);
};
