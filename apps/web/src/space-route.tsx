import type { ThreadId } from "@dx/domain";
import { useParams } from "@tanstack/react-router";
import * as React from "react";
import type { CommentableMessage } from "./features/spaces/comments/message-comments.js";
import { MessageCommentsPanel } from "./features/spaces/comments/message-comments.js";
import {
  type SpaceThreadSlots,
  SpaceWorkspace,
} from "./features/spaces/space-workspace.js";
import {
  useSendThreadTyping,
  useThreadPresence,
  useThreadTyping,
} from "./features/threads/realtime/realtime-provider.js";
import type { ThreadWorkspace } from "./features/threads/thread-workspace.js";
import type { DictationSlot } from "./shared/dictation/dictation-slot.js";

type ThreadWorkspaceProps = React.ComponentProps<typeof ThreadWorkspace>;

/** The open post's comments, with who is typing from the realtime hub. */
function SpaceCommentsOverlay({
  threadId,
  findMessage,
  dictation,
}: {
  readonly threadId: ThreadId;
  readonly findMessage: (messageId: string) => CommentableMessage | undefined;
  readonly dictation: DictationSlot | undefined;
}) {
  const typing = useThreadTyping(threadId);
  const sendTyping = useSendThreadTyping(threadId);
  return (
    <MessageCommentsPanel
      threadId={threadId}
      findMessage={findMessage}
      typing={typing}
      onTyping={sendTyping}
      dictation={dictation}
    />
  );
}

/**
 * A Space's page, composed here because features do not reach into each
 * other: the Spaces feature lays out the page and its chat of posts, the
 * realtime hub keeps the posts and comments live, and the Thread page
 * renders a thread the Space started in its tab. The Thread route hands
 * over its Thread page and the composer's mic, so this lazily loaded page
 * shares their code rather than splitting it out of the Thread page's
 * first load.
 */
export function SpaceRoute({
  renderThread,
  dictation,
}: {
  readonly renderThread: (props: ThreadWorkspaceProps) => React.ReactNode;
  readonly dictation: DictationSlot | undefined;
}) {
  const { threadId } = useParams({ from: "/_product/threads/$threadId" });
  const spaceThreadId = threadId as ThreadId;
  // The Space's own Thread is never rendered as a Thread page here, so the
  // page joins its realtime topic itself: posts and comments arrive there.
  useThreadPresence(spaceThreadId);
  const renderSpaceThread = (slots: SpaceThreadSlots) => (
    <React.Fragment key={slots.threadId}>{renderThread(slots)}</React.Fragment>
  );
  return (
    <SpaceWorkspace
      renderThread={renderSpaceThread}
      renderComments={({ findMessage }) => (
        <SpaceCommentsOverlay
          threadId={spaceThreadId}
          findMessage={findMessage}
          dictation={dictation}
        />
      )}
      dictation={dictation}
    />
  );
}
