import type { ThreadListItem } from "@dx/api";
import type { ThreadId } from "@dx/domain";

export interface ThreadTreeNode {
  readonly thread: ThreadListItem;
  readonly children: ReadonlyArray<ThreadTreeNode>;
  /** Every Thread below this one. */
  readonly descendants: number;
}

const byCreation = (left: ThreadListItem, right: ThreadListItem) =>
  left.createdAt.epochMilliseconds - right.createdAt.epochMilliseconds ||
  left.id.localeCompare(right.id);

/**
 * A family as an outline: each Thread under the one that started it, oldest
 * first. A Thread whose starter is not in the family as the requester reads
 * it (started before dx recorded starters, or a starter they may not read)
 * goes under the root, or to the top when the root is missing too. A
 * starter chain that loops is cut where it would revisit a Thread.
 */
export const buildThreadTree = (
  rootThreadId: ThreadId,
  items: ReadonlyArray<ThreadListItem>,
): ReadonlyArray<ThreadTreeNode> => {
  const byId = new Map(items.map((thread) => [thread.id, thread]));
  const parentOf = (thread: ThreadListItem): ThreadId | undefined => {
    if (thread.id === rootThreadId) return undefined;
    const starter = thread.startedByThreadId;
    if (starter !== undefined && starter !== thread.id && byId.has(starter))
      return starter;
    return byId.has(rootThreadId) ? rootThreadId : undefined;
  };
  // Follow each chain of starters; a Thread that reaches itself starts a
  // new top-level branch instead.
  const parents = new Map<ThreadId, ThreadId | undefined>();
  for (const thread of items) {
    const seen = new Set<ThreadId>([thread.id]);
    let parent = parentOf(thread);
    let cursor = parent;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        parent =
          byId.has(rootThreadId) && thread.id !== rootThreadId
            ? rootThreadId
            : undefined;
        break;
      }
      seen.add(cursor);
      const next = byId.get(cursor);
      cursor = next === undefined ? undefined : parentOf(next);
    }
    parents.set(thread.id, parent);
  }
  const childrenOf = new Map<ThreadId | undefined, ThreadListItem[]>();
  for (const thread of items) {
    const parent = parents.get(thread.id);
    const siblings = childrenOf.get(parent) ?? [];
    siblings.push(thread);
    childrenOf.set(parent, siblings);
  }
  const build = (thread: ThreadListItem): ThreadTreeNode => {
    const children = (childrenOf.get(thread.id) ?? [])
      .toSorted(byCreation)
      .map(build);
    return {
      thread,
      children,
      descendants: children.reduce(
        (total, child) => total + 1 + child.descendants,
        0,
      ),
    };
  };
  return (childrenOf.get(undefined) ?? []).toSorted(byCreation).map(build);
};
