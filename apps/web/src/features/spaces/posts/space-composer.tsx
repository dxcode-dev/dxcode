import { type MessageAttachment, withMessageAttachments } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { useCommentMentions } from "../../../shared/comments/comment-mention-menu.js";
import type { ComposerSlot } from "../../../shared/composer/composer-slot.js";
import { appendQuote } from "../../../shared/ui/selection-actions.js";
import { useComposerDraft } from "../../threads/composer-draft-queries.js";
import { useSpacePeople } from "./space-people.js";
import { postFailureText } from "./space-post-format.js";
import { useCreateSpacePost } from "./space-posts-queries.js";

/**
 * The Space's composer: what a person writes becomes a post every member
 * sees, and dx reads it from there. It is the Thread composer's box (the
 * Thread route hands it over as `Composer`): files, the mic, and the same
 * Enter key. The text shows as a pending post until the server takes it.
 */
export function SpaceComposer({
  spaceThreadId,
  Composer,
  replyRef,
  notice,
}: {
  readonly spaceThreadId: ThreadId;
  readonly Composer: ComposerSlot;
  /** Set to quote text (a selection in the chat) into the box. */
  readonly replyRef?: React.RefObject<((quote: string) => void) | undefined>;
  /** A card above the box, such as the Space agent's Claude plan limit. */
  readonly notice?: React.ReactNode;
}) {
  const { identity } = useAuthenticatedIdentity();
  // Core keeps it per person, as a Thread's composer does: leaving the
  // Space, a reload, or another device shows what was typed.
  const [draft, setDraft] = useComposerDraft({ threadId: spaceThreadId });
  // A post that fails comes back to the box, ahead of anything typed since.
  const create = useCreateSpacePost(identity.id, spaceThreadId, (failed) =>
    setDraft((current) =>
      current.trim() === "" ? failed : `${failed}\n\n${current}`,
    ),
  );
  const box = React.useRef<HTMLTextAreaElement | null>(null);
  const { members } = useSpacePeople(spaceThreadId);
  // `@` lists the Space's people as the comment box does; a pick posts as
  // the member's mention, which notifies them. Picks stay, so a draft that
  // comes back after a failure posts the same mentions.
  const mentions = useCommentMentions({
    members,
    body: draft,
    setBody: setDraft,
    box,
  });
  React.useImperativeHandle(replyRef, () => (quote) => {
    const next = appendQuote(draft, quote);
    setDraft(next);
    // After React writes the draft: the caret goes below the quote.
    requestAnimationFrame(() => {
      const textarea = box.current;
      if (textarea === null) return;
      textarea.focus();
      textarea.setSelectionRange(next.length, next.length);
    });
  });
  // Sent while another post is still sending, it waits its turn and shows
  // as sending in the chat meanwhile. Its files follow the text as the
  // attachment block a Thread message carries.
  const send = (text: string, attachments: ReadonlyArray<MessageAttachment>) =>
    create
      .mutateAsync({
        text: withMessageAttachments(mentions.post(text.trim()), attachments),
        draft: text.trim(),
      })
      .then(
        () => true,
        () => false,
      );
  return (
    <Composer
      label="Post to Space"
      sendLabel="Send Post"
      className="space-composer-dock"
      draft={draft}
      onDraftChange={setDraft}
      onSend={send}
      textareaRef={box}
      onTextInput={mentions.track}
      onKeyDown={mentions.onKeyDown}
      above={
        <>
          {notice}
          {create.isError ? (
            <p className="space-composer-error" role="alert">
              {postFailureText(create.error)}
            </p>
          ) : null}
          {mentions.menu}
        </>
      }
    />
  );
}
