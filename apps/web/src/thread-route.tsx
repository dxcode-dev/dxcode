import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { DesktopViewer } from "./features/desktop/desktop-viewer.js";
import { ThreadTerminal } from "./features/terminal/thread-terminal.js";
import { threadQueryOptions } from "./features/threads/thread-queries.js";
import { ThreadWorkspace } from "./features/threads/thread-workspace.js";
import { useAuthenticatedIdentity } from "./shared/auth/auth-context.js";
import { DocumentTitle } from "./shared/ui/document-title.js";

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

export const ThreadRoute = () => (
  <>
    <ThreadDocumentTitle />
    <ThreadWorkspace Terminal={ThreadTerminal} Desktop={DesktopViewer} />
  </>
);
