import type { ThreadId } from "@dx/domain";
import { useParams } from "@tanstack/react-router";
import { ThreadTreePage } from "./features/threads/thread-tree/thread-tree-page.js";

export const ThreadTreeRoute = () => {
  const { threadId } = useParams({ from: "/_product/threads/$threadId/tree" });
  // Core rejects a malformed ID, which the page reports.
  return <ThreadTreePage key={threadId} threadId={threadId as ThreadId} />;
};
