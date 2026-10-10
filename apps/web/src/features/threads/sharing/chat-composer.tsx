import {
  AGENT_MENTION,
  type ThreadConversationMode,
  type ThreadMemberData,
} from "@dx/api";
import { Bot, LockKeyhole, MessagesSquare } from "lucide-react";
import * as React from "react";
import { Avatar } from "../../../shared/ui/avatar.js";
import {
  activeMention,
  draftMode,
  type MentionOption,
  mentionOptions,
} from "./thread-chat.js";
import "./thread-sharing.css";

/**
 * What `@` does in the composer: in a shared Thread it tags workspace members
 * (chat) or the agent; in the owner's private Thread it explains sharing.
 */
export type ComposerMentions =
  | {
      readonly mode: "members";
      readonly members: ReadonlyArray<ThreadMemberData>;
      /** The signed-in member, who is never offered. */
      readonly viewerId: string;
      readonly conversationMode: ThreadConversationMode;
      /** A message was admitted in this mode. */
      readonly onSent: (mode: ThreadConversationMode) => void;
    }
  | { readonly mode: "share"; readonly onOpenShare: () => void };

/**
 * Mention suggestions, the private-Thread hint, and the chat-mode banner for
 * a composer textarea. The caret and dismissal are this composer's own
 * ephemeral state; the draft stays with its owner.
 */
export const useComposerMentions = ({
  mentions,
  draft,
  setDraft,
  textareaRef,
}: {
  readonly mentions?: ComposerMentions;
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) => {
  const listId = React.useId();
  const [caret, setCaret] = React.useState<number>();
  const [dismissed, setDismissed] = React.useState<number>();
  const [highlight, setHighlight] = React.useState(0);
  const mention =
    mentions === undefined || caret === undefined
      ? undefined
      : activeMention(draft, caret);
  const open = mention !== undefined && dismissed !== mention.start;
  const options =
    open && mentions?.mode === "members"
      ? mentionOptions(mention.query, mentions.members, mentions.viewerId)
      : [];
  const active = Math.min(highlight, Math.max(options.length - 1, 0));
  const chatMode =
    mentions?.mode === "members" &&
    draftMode(
      draft,
      mentions.members,
      mentions.viewerId,
      mentions.conversationMode,
    ) === "chat";

  const trackCaret = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const position = event.currentTarget.selectionStart;
    setCaret((current) => (current === position ? current : position));
  };
  /** Typing reopens suggestions that Escape or Share closed. */
  const onInput = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setDismissed(undefined);
    trackCaret(event);
  };

  const choose = (option: MentionOption) => {
    if (mention === undefined || caret === undefined) return;
    const inserted = `@${option.handle} `;
    const next = `${draft.slice(0, mention.start)}${inserted}${draft.slice(caret).replace(/^\s+/, "")}`;
    const position = mention.start + inserted.length;
    setDraft(next);
    setCaret(position);
    setHighlight(0);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea === null) return;
      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  };

  /** Handles keys the suggestions own; returns whether it did. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      setDismissed(mention.start);
      return true;
    }
    if (options.length === 0) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((active + step + options.length) % options.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const option = options[active];
      if (option === undefined) return false;
      choose(option);
      return true;
    }
    return false;
  };

  const optionId = (index: number) => `${listId}-${index}`;
  const popover = !open ? null : mentions?.mode === "share" ? (
    <div className="composer-mention-card" role="note">
      <LockKeyhole aria-hidden="true" />
      <span>
        People can't be mentioned in private threads. Share the thread to{" "}
        <button
          type="button"
          className="composer-mention-link"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setDismissed(mention.start);
            mentions.onOpenShare();
          }}
        >
          tag workspace members
        </button>
        .
      </span>
    </div>
  ) : options.length === 0 ? null : (
    <div
      className="composer-mention-card composer-mention-list"
      id={listId}
      role="listbox"
      aria-label="Mention"
    >
      {options.map((option, index) => (
        <div
          key={option.kind === "agent" ? "agent" : option.member.userId}
          id={optionId(index)}
          role="option"
          tabIndex={-1}
          aria-selected={index === active}
          className="composer-mention-option"
          data-active={index === active ? "" : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setHighlight(index)}
          onClick={() => choose(option)}
          onKeyDown={(event) => {
            if (event.key === "Enter") choose(option);
          }}
        >
          {option.kind === "agent" ? (
            <span className="dx-avatar composer-mention-agent">
              <Bot aria-hidden="true" />
            </span>
          ) : (
            <Avatar
              name={option.member.name}
              image={option.member.image}
              seed={option.member.userId}
            />
          )}
          <span className="composer-mention-handle">@{option.handle}</span>
          <span className="composer-mention-name">
            {option.kind === "member"
              ? option.member.name
              : chatMode
                ? "Exit chat mode"
                : "Ask the agent"}
          </span>
        </div>
      ))}
    </div>
  );

  const banner = chatMode ? (
    <div className="composer-chat-banner" role="status">
      <MessagesSquare aria-hidden="true" />
      <span>
        You're in chat mode. Tag <strong>@{AGENT_MENTION}</strong> to get back
        to hacking.
      </span>
    </div>
  ) : null;

  return {
    popover,
    banner,
    chatMode,
    onKeyDown,
    onInput,
    trackCaret,
    textareaProps:
      options.length > 0
        ? {
            "aria-controls": listId,
            "aria-activedescendant": optionId(active),
            "aria-autocomplete": "list" as const,
          }
        : {},
  };
};
