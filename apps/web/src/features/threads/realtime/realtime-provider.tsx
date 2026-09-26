import type { ThreadId, UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";
import { RealtimeClient } from "./realtime-client.js";

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
  const subscribe = React.useCallback(
    (_onStoreChange: () => void) =>
      client?.observeThread(threadId) ?? (() => undefined),
    [client, threadId],
  );
  React.useSyncExternalStore(subscribe, presenceSnapshot, presenceSnapshot);
};

export const useThreadWorkspaceStatus = (threadId: ThreadId) => {
  const client = React.use(RealtimeContext);
  const subscribe = React.useCallback(
    (onStoreChange: () => void) =>
      client?.observeWorkspaceStatus(threadId, onStoreChange) ??
      (() => undefined),
    [client, threadId],
  );
  const snapshot = React.useCallback(
    () => client?.workspaceStatus(threadId),
    [client, threadId],
  );
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
};
