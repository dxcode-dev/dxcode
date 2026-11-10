import type { SpaceThreadItem, ThreadDetailData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { threadColorAttributes } from "../../shared/thread-color.js";

/** What a thread's tab shows: from the open Thread, or its Space row. */
export interface ThreadTabThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly working: boolean;
  readonly colors: ReturnType<typeof threadColorAttributes>;
}

export const threadTabOfItem = (
  threadId: ThreadId,
  item: SpaceThreadItem | undefined,
): ThreadTabThread => ({
  id: threadId,
  title: item?.title ?? "Thread",
  working: item?.state === "working",
  colors: threadColorAttributes(item ?? { id: threadId }),
});

export const threadTabOfThread = (
  thread: ThreadDetailData,
): ThreadTabThread => ({
  id: thread.id,
  title: thread.title,
  working:
    thread.lifecycleState !== "archived" && thread.activityStatus === "working",
  colors: threadColorAttributes(thread),
});
