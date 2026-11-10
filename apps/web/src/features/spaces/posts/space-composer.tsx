import { type MessageAttachment, withMessageAttachments } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { ArchiveRestore } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { useCommentMentions } from "../../../shared/comments/comment-mention-menu.js";
import type { ComposerSlot } from "../../../shared/composer/composer-slot.js";
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
}: {
  readonly spaceThreadId: ThreadId;
  readonly Composer: ComposerSlot;
}) {
  const { identity } = useAuthenticatedIdentity();
  const [draft, setDraft] = React.useState("");
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
          {create.isError ? (
            <p className="space-composer-error" role="alert">
              {postFailureText(create.error, "post")}
            </p>
          ) : null}
          {mentions.menu}
        </>
      }
    />
  );
}

/** In place of the composer while the Space is archived. */
export function UnarchiveToContinue({
  pending,
  onUnarchive,
}: {
  readonly pending: boolean;
  readonly onUnarchive?: () => void;
}) {
  return (
    <div className="agent-composer-dock space-composer-dock">
      <button
        type="button"
        className="space-unarchive"
        disabled={onUnarchive === undefined || pending}
        aria-busy={pending || undefined}
        onClick={onUnarchive}
      >
        <ArchiveRestore aria-hidden="true" />
        Unarchive to Continue
      </button>
    </div>
  );
}
