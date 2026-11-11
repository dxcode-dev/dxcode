import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { lazyRouteComponent, useParams } from "@tanstack/react-router";
import { Monitor, SquareTerminal } from "lucide-react";
import * as React from "react";
import { ThreadAutomationMenuItems } from "./features/threads/automations/thread-automation-menu-items.js";
import { ThreadAutomationsButton } from "./features/threads/automations/thread-automations-button.js";
import { ThreadAutomationsSheet } from "./features/threads/automations/thread-automations-sheet.js";
import { useDictationSlot } from "./features/threads/dictation/use-dictation.js";
import {
  MessageFileLinks,
  MessageImageTiles,
} from "./features/threads/message-attachments-ui.js";
import { threadQueryOptions } from "./features/threads/thread-queries.js";
import { ThreadWorkspace } from "./features/threads/thread-workspace.js";
import { useAuthenticatedIdentity } from "./shared/auth/auth-context.js";
import type { MessageFilesSlot } from "./shared/composer/composer-slot.js";
import type { ThreadAutomationsSlot } from "./shared/thread-automations-slot.js";
import { DocumentTitle } from "./shared/ui/document-title.js";

// The Terminal and Desktop load when their tab first shows, not with the
// transcript. `lazyRouteComponent` reloads the page once if a deploy removed
// the chunk.
const LazyTerminal = lazyRouteComponent(
  () => import("./features/terminal/thread-terminal.js"),
  "ThreadTerminal",
);
const LazyDesktop = lazyRouteComponent(
  () => import("./features/desktop/desktop-viewer.js"),
  "DesktopViewer",
);

/** The Terminal; its own waking state shows while its code loads. */
function ThreadTerminal(props: React.ComponentProps<typeof LazyTerminal>) {
  return (
    <React.Suspense
      fallback={
        <div className="thread-terminal-shell">
          <div className="thread-terminal-loading" role="status">
            <SquareTerminal
              className="workspace-loading-glyph"
              aria-hidden="true"
            />
            <span className="sr-only">Waking terminal…</span>
          </div>
        </div>
      }
    >
      <LazyTerminal {...props} />
    </React.Suspense>
  );
}

/** The Desktop; its own starting state shows while its code loads. */
function DesktopViewer(props: React.ComponentProps<typeof LazyDesktop>) {
  return (
    <React.Suspense
      fallback={
        <div className="thread-desktop-shell">
          <div className="thread-desktop-loading" role="status">
            <Monitor className="workspace-loading-glyph" aria-hidden="true" />
            <span className="sr-only">Starting desktop…</span>
          </div>
        </div>
      }
    >
      <LazyDesktop {...props} />
    </React.Suspense>
  );
}

/** The tab names the Thread once its title settles, and follows renames. */
function ThreadDocumentTitle() {
  const { threadId } = useParams({ from: "/_product/threads/$threadId" });
  const { identity } = useAuthenticatedIdentity();
  const { data: title } = useQuery({
    ...threadQueryOptions(identity.id, threadId as ThreadId),
    select: (thread) =>
      thread.titlePending === true ? undefined : thread.title,
  });
  return title === undefined ? null : <DocumentTitle name={title} />;
}

// A Space's page loads when a Space first opens, so other Thread pages
// never load its panel, dialogs, or requests.
const SpaceRoute = lazyRouteComponent(
  () => import("./space-route.js"),
  "SpaceRoute",
);

/** The transcript's file views, for a Space's posts. */
const MESSAGE_FILES: MessageFilesSlot = {
  Images: MessageImageTiles,
  Links: MessageFileLinks,
};

/** A Thread's issues, pull requests, CI, and listeners, for a Space. */
const AUTOMATIONS: ThreadAutomationsSlot = {
  Chips: ThreadAutomationsButton,
  MenuItems: ThreadAutomationMenuItems,
  Sheet: ThreadAutomationsSheet,
};

const renderSpaceThread = (
  props: React.ComponentProps<typeof ThreadWorkspace>,
) => (
  <ThreadWorkspace
    Terminal={ThreadTerminal}
    Desktop={DesktopViewer}
    {...props}
  />
);

/** A Space's page, or any other Thread's, by the Thread's kind. */
function ThreadOrSpaceWorkspace() {
  const { threadId } = useParams({ from: "/_product/threads/$threadId" });
  const { identity } = useAuthenticatedIdentity();
  const dictation = useDictationSlot();
  const { data: space } = useQuery({
    ...threadQueryOptions(identity.id, threadId as ThreadId),
    select: (thread) => thread.kind === "space",
  });
  return space === true ? (
    <React.Suspense fallback={null}>
      <SpaceRoute
        key={threadId}
        renderThread={renderSpaceThread}
        dictation={dictation}
        files={MESSAGE_FILES}
        automations={AUTOMATIONS}
      />
    </React.Suspense>
  ) : (
    <ThreadWorkspace Terminal={ThreadTerminal} Desktop={DesktopViewer} />
  );
}

export const ThreadRoute = () => (
  <>
    <ThreadDocumentTitle />
    <ThreadOrSpaceWorkspace />
  </>
);
