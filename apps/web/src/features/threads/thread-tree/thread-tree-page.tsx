import type { ThreadListItem } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { PageShell } from "../../../shared/layout/page-shell.js";
import { threadColorAttributes } from "../../../shared/thread-color.js";
import { OrbIcon } from "../../../shared/ui/orb-icon.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import { buildThreadTree, type ThreadTreeNode } from "./thread-tree-outline.js";
import { threadTreeQueryOptions } from "./thread-tree-queries.js";
import "./thread-tree.css";

const plural = (count: number) => `${count} thread${count === 1 ? "" : "s"}`;

/**
 * The family of a Thread as an outline: each Thread under the one that
 * started it, with the Thread the page opened from marked current.
 */
export function ThreadTreePage({ threadId }: { readonly threadId: ThreadId }) {
  const { identity } = useAuthenticatedIdentity();
  const tree = useQuery(threadTreeQueryOptions(identity.id, threadId));
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<ThreadId>>(
    () => new Set(),
  );
  const toggle = (id: ThreadId) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const data = tree.data;
  const roots =
    data === undefined ? [] : buildThreadTree(data.rootThreadId, data.items);
  const rootColor = data?.items.find(
    ({ id }) => id === data.rootThreadId,
  )?.color;
  const state =
    data !== undefined ? "ready" : tree.isError ? "error" : "loading";
  return (
    <PageShell
      title={
        <div className="thread-tree-title">
          <Link
            className="thread-tree-back"
            to="/threads/$threadId"
            params={{ threadId }}
            aria-label="Back to thread"
            title="Back to thread"
          >
            <ArrowLeft aria-hidden />
          </Link>
          <strong>Thread tree</strong>
          {data === undefined ? null : (
            <span className="thread-tree-count">
              {plural(data.items.length)}
            </span>
          )}
        </div>
      }
      contentClassName="thread-tree-content"
    >
      <div data-thread-tree-state={state}>
        {state === "loading" ? (
          <p className="thread-tree-note" role="status">
            Loading threads…
          </p>
        ) : state === "error" ? (
          <p className="thread-tree-note" role="alert">
            This thread's tree could not be loaded.{" "}
            <button type="button" onClick={() => void tree.refetch()}>
              Retry
            </button>
          </p>
        ) : (
          <>
            <ul className="thread-tree">
              {roots.map((node) => (
                <ThreadTreeRow
                  key={node.thread.id}
                  node={node}
                  depth={0}
                  currentThreadId={threadId}
                  collapsed={collapsed}
                  onToggle={toggle}
                  rootColor={rootColor}
                />
              ))}
            </ul>
            {data?.truncated === true ? (
              <p className="thread-tree-note">
                This family is too large to show in full; its newest threads are
                not shown.
              </p>
            ) : null}
          </>
        )}
      </div>
    </PageShell>
  );
}

function ThreadTreeRow({
  node,
  depth,
  currentThreadId,
  collapsed,
  onToggle,
  rootColor,
}: {
  readonly node: ThreadTreeNode;
  readonly depth: number;
  readonly currentThreadId: ThreadId;
  readonly collapsed: ReadonlySet<ThreadId>;
  readonly onToggle: (id: ThreadId) => void;
  readonly rootColor: ThreadListItem["color"];
}) {
  const { thread, children } = node;
  const open = !collapsed.has(thread.id);
  const current = thread.id === currentThreadId;
  const archived = thread.lifecycleState === "archived";
  return (
    <li
      className="thread-tree-node"
      data-tree-node={thread.id}
      data-depth={depth}
      style={{ "--thread-tree-depth": depth } as React.CSSProperties}
    >
      <div className="thread-tree-row" data-current={current ? "" : undefined}>
        {children.length === 0 ? (
          <span className="thread-tree-toggle-space" />
        ) : (
          <button
            type="button"
            className="thread-tree-toggle"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${plural(node.descendants)} under ${thread.title}`}
            onClick={() => onToggle(thread.id)}
          >
            {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          </button>
        )}
        <Link
          className="thread-tree-link"
          to="/threads/$threadId"
          params={{ threadId: thread.id }}
          aria-current={current ? "page" : undefined}
          data-archived={archived ? "" : undefined}
          {...threadColorAttributes({
            ...thread,
            ...(rootColor === undefined ? {} : { parentColor: rootColor }),
          })}
        >
          <span className="thread-tree-orb">
            <OrbIcon
              activityStatus={archived ? "idle" : thread.activityStatus}
              unread={thread.unread === true}
              aria-hidden="false"
              aria-label={`${
                archived
                  ? "Archived"
                  : thread.activityStatus === "working"
                    ? "Working"
                    : "Idle"
              }${thread.unread === true ? ", unread" : ""}`}
            />
          </span>
          <span className="thread-tree-label" data-tree-title>
            {thread.title}
          </span>
        </Link>
        {!open ? (
          <span
            className="thread-tree-hidden"
            title={`${plural(node.descendants)} hidden`}
            data-hidden-count
          >
            {node.descendants}
          </span>
        ) : null}
        {thread.turnFailed === true ? (
          <span
            className="thread-tree-mark thread-tree-error"
            title="The latest turn ended in an error"
          >
            Error
          </span>
        ) : null}
        {archived ? <span className="thread-tree-mark">Archived</span> : null}
        <span className="thread-tree-time">
          <TimeText
            text={(now) => formatRelativeTime(thread.lastActivityAt, now)}
          />
        </span>
      </div>
      {open && children.length > 0 ? (
        <ul className="thread-tree">
          {children.map((child) => (
            <ThreadTreeRow
              key={child.thread.id}
              node={child}
              depth={depth + 1}
              currentThreadId={currentThreadId}
              collapsed={collapsed}
              onToggle={onToggle}
              rootColor={rootColor}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
