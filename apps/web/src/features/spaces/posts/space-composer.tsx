import type { ThreadId } from "@dx/domain";
import { ArchiveRestore, ArrowUp } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { useCommentMentions } from "../../../shared/comments/comment-mention-menu.js";
import type { DictationSlot } from "../../../shared/dictation/dictation-slot.js";
import { Button } from "../../../shared/ui/button.js";
import { useSpacePeople } from "./space-people.js";
import { postFailureText } from "./space-post-format.js";
import { useCreateSpacePost } from "./space-posts-queries.js";

/**
 * The Space's composer: what a person writes becomes a post every member
 * sees, and dx reads it from there. Enter sends; Shift+Enter breaks a line.
 * The text shows as a pending post until the server takes it.
 */
export function SpaceComposer({
  spaceThreadId,
  dictation,
}: {
  readonly spaceThreadId: ThreadId;
  readonly dictation?: DictationSlot;
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
  // as sending in the chat meanwhile.
  const send = () => {
    const text = draft.trim();
    if (text === "") return;
    setDraft("");
    create.mutate({ text: mentions.post(text), draft: text });
  };
  const change = (value: string, caret: number) => {
    setDraft(value);
    mentions.track(value, caret);
  };
  return (
    <div className="agent-composer-dock space-composer-dock">
      {create.isError ? (
        <p className="space-composer-error" role="alert">
          {postFailureText(create.error, "post")}
        </p>
      ) : null}
      {mentions.menu}
      <form
        className="agent-composer space-composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <textarea
          ref={box}
          aria-label="Post to Space"
          value={draft}
          onChange={(event) =>
            change(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            )
          }
          onKeyDown={(event) => {
            if (mentions.onKeyDown(event)) return;
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-actions">
          <span className="composer-spacer" />
          {dictation === undefined ? null : (
            <dictation.Textarea textareaRef={box} onChange={setDraft} />
          )}
          <Button
            type="submit"
            size="icon-sm"
            className="composer-submit"
            aria-label="Send Post"
            disabled={draft.trim() === ""}
          >
            <ArrowUp />
          </Button>
        </div>
      </form>
    </div>
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
