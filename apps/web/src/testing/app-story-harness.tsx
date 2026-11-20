import type { UserId } from "@dx/domain";
import { useQueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import * as React from "react";
import { NewThreadProvider } from "../features/threads/new-thread-provider.js";
import { ThreadSessionRegistryContext } from "../features/threads/thread-session-context.js";
import { ThreadSessionRegistry } from "../features/threads/thread-session-registry.js";
import { AuthContext } from "../shared/auth/auth-context.js";
import { Toaster } from "../shared/ui/sonner.js";
import { StoryQueryProvider } from "./story-query-provider.js";

/** The signed-in person in stories that render the app's own providers. */
export const storyUserId = "usr_story" as UserId;

function OpenedThread() {
  const { threadId } = useParams({ strict: false });
  return (
    <p role="status" className="sr-only">
      Opened thread {threadId}
    </p>
  );
}

function Providers({ children }: { readonly children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [registry] = React.useState(
    () => new ThreadSessionRegistry(queryClient, storyUserId),
  );
  return (
    <AuthContext.Provider
      value={{
        identity: {
          id: storyUserId,
          name: "Alex Rivera",
          email: "alex@example.com",
        },
        logout: () => undefined,
      }}
    >
      <ThreadSessionRegistryContext.Provider value={registry}>
        <NewThreadProvider>{children}</NewThreadProvider>
      </ThreadSessionRegistryContext.Provider>
    </AuthContext.Provider>
  );
}

/**
 * The app's providers around a story: the signed-in person, the Thread
 * session registry, and the New Thread surface (the same composer the app
 * opens), under a router whose `/threads/$threadId` says which Thread opened.
 */
export function AppStoryHarness({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const [router] = React.useState(() => {
    const root = createRootRoute({
      component: () => (
        <Providers>
          {children}
          <Outlet />
          <Toaster />
        </Providers>
      ),
    });
    const thread = createRoute({
      getParentRoute: () => root,
      path: "/threads/$threadId",
      component: OpenedThread,
    });
    const settings = createRoute({
      getParentRoute: () => root,
      path: "/settings/$section",
    });
    const home = createRoute({ getParentRoute: () => root, path: "/" });
    return createRouter({
      routeTree: root.addChildren([home, thread, settings]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  });
  return (
    <StoryQueryProvider>
      <RouterProvider router={router as never} />
    </StoryQueryProvider>
  );
}
