import type { SettingsWorkspaceData, ThreadMemberData } from "@dx/api";
import {
  isDefaultPersonalAccountUsername,
  type UserId,
  type WorkspaceSlug,
} from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Avatar } from "../../shared/ui/avatar.js";
import { workspaceMembersQueryOptions } from "../settings/members/members-queries.js";
import "./sharing/thread-sharing.css";

// The matching below follows `sharing/thread-chat.ts`, which the Thread page
// loads first. Importing it from here would split it out of the Thread
// page's first chunk and push that page over its size budget.

/**
 * Whom `@` can tag in a new Thread: the workspace's members with a handle.
 * Undefined outside a workspace, or until the list loads.
 */
export const useWorkspaceMentionMembers = (
  userId: UserId,
  workspace: SettingsWorkspaceData | undefined,
): ReadonlyArray<ThreadMemberData> | undefined => {
  const membersQuery = useQuery({
    ...workspaceMembersQueryOptions(
      userId,
      (workspace?.shortName ?? "") as WorkspaceSlug,
    ),
    enabled: workspace !== undefined,
  });
  return membersQuery.data?.members.flatMap((member) =>
    member.handle === undefined
      ? []
      : [
          {
            userId: member.userId as UserId,
            name: member.name,
            handle: member.handle,
            email: member.email,
            ...(member.image === undefined ? {} : { image: member.image }),
          },
        ],
  );
};

/** The `@` word the caret is in, if any: where it starts and what follows. */
const activeMention = (prompt: string, caret: number) => {
  const match = /(^|\s)@([^\s@]*)$/u.exec(prompt.slice(0, caret));
  if (match === null) return undefined;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query };
};

/** `@username`, or `@Name` for someone still on the sign-up placeholder. */
const mentionLabel = (member: ThreadMemberData) =>
  `@${isDefaultPersonalAccountUsername(member.handle) ? member.name : member.handle}`;

/** Other members whose name or chosen handle starts a word with `query`. */
const mentionOptions = (
  query: string,
  members: ReadonlyArray<ThreadMemberData>,
  viewerId: string,
) => {
  const wanted = query.toLowerCase();
  const matches = (text: string) =>
    text
      .toLowerCase()
      .split(/[\s_-]+/)
      .some((word) => word.startsWith(wanted)) ||
    text.toLowerCase().startsWith(wanted);
  return members
    .filter(
      (member) =>
        member.userId !== viewerId &&
        ((!isDefaultPersonalAccountUsername(member.handle) &&
          matches(member.handle)) ||
          matches(member.name)),
    )
    .slice(0, 8);
};

/**
 * `@` in the new-Thread prompt (#1636): the workspace's other members, by the
 * same matching and look as a shared Thread's composer. A new Thread's first
 * message always goes to the agent, so neither the agent nor chat mode is
 * offered. Choosing someone calls `onMention`, which shares the Thread with
 * the workspace so they can open it. Kept apart from the shared Thread's
 * hook, which loads with every Thread page.
 */
export const useNewThreadMentions = ({
  members,
  viewerId,
  prompt,
  setPrompt,
  textareaRef,
  onMention,
}: {
  /** Undefined outside a workspace: `@` stays plain text. */
  readonly members?: ReadonlyArray<ThreadMemberData>;
  readonly viewerId: string;
  readonly prompt: string;
  readonly setPrompt: (prompt: string) => void;
  readonly textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  readonly onMention: () => void;
}) => {
  const listId = React.useId();
  const [caret, setCaret] = React.useState<number>();
  const [dismissed, setDismissed] = React.useState<number>();
  const [highlight, setHighlight] = React.useState(0);
  const mention =
    members === undefined || caret === undefined
      ? undefined
      : activeMention(prompt, caret);
  const options =
    mention === undefined || dismissed === mention.start
      ? []
      : mentionOptions(mention.query, members ?? [], viewerId);
  const active = Math.min(highlight, Math.max(options.length - 1, 0));

  const trackCaret = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const position = event.currentTarget.selectionStart;
    setCaret((current) => (current === position ? current : position));
  };
  const choose = (member: ThreadMemberData) => {
    if (mention === undefined || caret === undefined) return;
    const inserted = `@${member.handle} `;
    const position = mention.start + inserted.length;
    onMention();
    setPrompt(
      `${prompt.slice(0, mention.start)}${inserted}${prompt.slice(caret).replace(/^\s+/, "")}`,
    );
    setCaret(position);
    setHighlight(0);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea === null) return;
      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  };
  /** Handles the keys the list owns; returns whether it did. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (options.length === 0 || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") {
      setDismissed(mention?.start);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((active + step + options.length) % options.length);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const member = options[active];
      if (member === undefined) return false;
      choose(member);
      return true;
    }
    return false;
  };
  const optionId = (index: number) => `${listId}-${index}`;

  return {
    onKeyDown,
    /** Typing reopens a list Escape closed. */
    onInput: (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      setDismissed(undefined);
      trackCaret(event);
    },
    trackCaret,
    textareaProps:
      options.length > 0
        ? {
            "aria-controls": listId,
            "aria-activedescendant": optionId(active),
            "aria-autocomplete": "list" as const,
          }
        : {},
    list:
      options.length === 0 ? null : (
        <div
          className="composer-mention-card composer-mention-list"
          id={listId}
          role="listbox"
          aria-label="Mention"
        >
          {options.map((member, index) => {
            const label = mentionLabel(member);
            return (
              <div
                key={member.userId}
                id={optionId(index)}
                role="option"
                tabIndex={-1}
                aria-selected={index === active}
                className="composer-mention-option"
                data-active={index === active ? "" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                // Only a moving mouse picks: Chrome also sends hover events when the
                // list opens under a resting one, which undid an arrow key.
                onMouseMove={(event) => {
                  if (event.movementX !== 0 || event.movementY !== 0)
                    setHighlight(index);
                }}
                onClick={() => choose(member)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") choose(member);
                }}
              >
                <Avatar
                  name={member.name}
                  image={member.image}
                  seed={member.userId}
                />
                <span className="composer-mention-handle">{label}</span>
                {label === `@${member.name}` ? null : (
                  <span className="composer-mention-name">{member.name}</span>
                )}
              </div>
            );
          })}
        </div>
      ),
  };
};
