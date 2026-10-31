import { Link } from "@tanstack/react-router";
import { Network } from "lucide-react";
import type { ThreadListClientItem } from "../../shared/api/client.js";
import { startedCountOf } from "./sidebar-thread-count.js";

/**
 * On a child Thread's row: how many Threads sit below it, those it started
 * and theirs, which the sidebar does not list. Opens their tree.
 */
export function SidebarThreadStartedCount({
  thread,
}: {
  readonly thread: Pick<
    ThreadListClientItem,
    "id" | "parentThreadId" | "startedCount"
  >;
}) {
  const count = startedCountOf(thread);
  if (count === 0) return null;
  const label = `${count} ${count === 1 ? "thread" : "threads"}`;
  return (
    <Link
      className="thread-children-toggle thread-started-count"
      to="/threads/$threadId/tree"
      params={{ threadId: thread.id }}
      aria-label={`Open the tree of the ${label} below this one`}
      title={`${label} below this one. Open the tree`}
    >
      <span className="thread-children-icon" aria-hidden>
        <Network />
      </span>
      <span className="thread-children-count">{count}</span>
    </Link>
  );
}
