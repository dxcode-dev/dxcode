import type { ProjectId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { lazyRouteComponent } from "@tanstack/react-router";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { CommandProvider } from "../../shared/commands/command-provider.js";
import {
  NewThreadSurfaceContext,
  type NewThreadSurfaceValue,
} from "../../shared/new-thread-surface.js";
import { composerDefaultsQueryOptions } from "../settings/composer/composer-defaults-queries.js";
import { projectDefaultsQueryOptions } from "../settings/project-defaults/project-defaults-queries.js";
import { ThreadSessionRegistryContext } from "./thread-session-context.js";

// The New Thread dialog and its composer load when it first opens, not with
// every page. `lazyRouteComponent` reloads the page once if a deploy removed
// the chunk.
const NewThreadModal = lazyRouteComponent(
  () => import("./new-thread-page.js"),
  "NewThreadModal",
);

export function NewThreadProvider({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const { identity } = useAuthenticatedIdentity();
  const registry = React.useContext(ThreadSessionRegistryContext);
  useQuery(projectDefaultsQueryOptions(identity.id, { scope: "personal" }));
  useQuery(composerDefaultsQueryOptions(identity.id));
  const [invocation, setInvocation] = React.useState<
    | {
        readonly key: number;
        readonly projectId?: ProjectId;
        readonly prompt?: string;
      }
    | undefined
  >();
  const returnFocus = React.useRef<{
    readonly element: HTMLElement | null;
    readonly mobileDrawer: boolean;
  }>({ element: null, mobileDrawer: false });
  const finalFocus = () => {
    if (returnFocus.current.element?.isConnected)
      return returnFocus.current.element;
    return returnFocus.current.mobileDrawer
      ? document.querySelector<HTMLElement>('[aria-label="Open sidebar"]')
      : null;
  };
  const value: NewThreadSurfaceValue = {
    openNewThread: (projectId, prompt) => {
      const element =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      returnFocus.current = {
        element: element === document.body ? null : element,
        mobileDrawer: element?.closest(".mobile-sidebar-drawer") !== null,
      };
      setInvocation({ key: Date.now(), projectId, prompt });
    },
    pendingCreations: registry?.pendingCreations,
    subscribePendingCreations: registry?.subscribeCreations,
  };

  return (
    <NewThreadSurfaceContext.Provider value={value}>
      <CommandProvider onOpenNewThread={value.openNewThread}>
        {children}
      </CommandProvider>
      {invocation === undefined ? null : (
        <React.Suspense fallback={null}>
          <NewThreadModal
            key={invocation.key}
            initialProjectId={invocation.projectId}
            initialPrompt={invocation.prompt}
            finalFocus={finalFocus}
            onClose={() => setInvocation(undefined)}
            onAccepted={() => setInvocation(undefined)}
          />
        </React.Suspense>
      )}
    </NewThreadSurfaceContext.Provider>
  );
}
