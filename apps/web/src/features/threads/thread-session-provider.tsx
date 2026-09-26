import type { UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { AuthContext, useIdentity } from "../../shared/auth/auth-context.js";
import { ThreadSessionRegistryContext } from "./thread-session-context.js";
import { ThreadSessionRegistry } from "./thread-session-registry.js";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";

export function ThreadSessionProvider({
  userId,
  queryClient,
  children,
}: {
  readonly userId: UserId;
  readonly queryClient: QueryClient;
  readonly children: React.ReactNode;
}) {
  const [registry] = React.useState(
    () => new ThreadSessionRegistry(queryClient, userId),
  );
  const auth = useIdentity();
  const retainedAuth = React.useMemo(
    () =>
      auth === undefined
        ? undefined
        : {
            ...auth,
            logout: () => {
              registry.clear();
              auth.logout();
            },
          },
    [auth, registry],
  );
  useMountEffect(() => {
    // StrictMode immediately reacquires the same provider before the microtask.
    const lease = { live: true };
    providerLeases.set(registry, lease);
    return () => {
      lease.live = false;
      queueMicrotask(() => {
        if (providerLeases.get(registry) === lease && !lease.live)
          registry.clear();
      });
    };
  });
  return (
    <ThreadSessionRegistryContext value={registry}>
      <AuthContext value={retainedAuth}>{children}</AuthContext>
    </ThreadSessionRegistryContext>
  );
}
const providerLeases = new WeakMap<ThreadSessionRegistry, { live: boolean }>();
