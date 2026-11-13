import type { ThreadMemberData } from "@dx/api";
import * as React from "react";
import { useAuthenticatedIdentity } from "../auth/auth-context.js";
import {
  mentionName,
  type PickedPeople,
  withMentions,
} from "./comment-mentions.js";
import { commentPeopleItems } from "./mention-items.js";
import { SuggestMenu } from "./suggest-menu.js";
import "./comments.css";

/** `@` and what follows it, up to the caret: a mention being typed. */
const TYPING = /(^|\s)@([^\s@]*)$/u;

interface Typing {
  /** Where the `@` is. */
  readonly start: number;
  readonly caret: number;
  readonly query: string;
  readonly active: number;
}

/**
 * `@` in a comment box (#1808): the list an artifact's body offers (dx and
 * the Thread's people, `members`) plus `@here`, above the box. A pick writes
 * the name as people read it; `post` turns each picked name, `@here`, and
 * `@dx` into the mention it notifies.
 */
export function useCommentMentions({
  members,
  body,
  setBody,
  box,
  initialPicked,
  agent = true,
}: {
  /** The Thread's people, from its members query. */
  readonly members: ReadonlyArray<ThreadMemberData>;
  readonly body: string;
  readonly setBody: (value: string) => void;
  readonly box: React.RefObject<HTMLTextAreaElement | null>;
  /** People already mentioned in a text being edited (`draftOf`). */
  readonly initialPicked?: PickedPeople;
  /** Whether `@` offers dx; a standalone artifact's home has no agent. */
  readonly agent?: boolean;
}) {
  const { identity } = useAuthenticatedIdentity();
  const [picked, setPicked] = React.useState<PickedPeople>(
    () => initialPicked ?? new Map(),
  );
  const [typing, setTyping] = React.useState<Typing>();
  // An `@` the person closed the list on stays closed while they type on.
  const [dismissed, setDismissed] = React.useState<number>();
  const items =
    typing === undefined
      ? []
      : commentPeopleItems(typing.query, members, identity.id, agent);

  /** Follows the caret: opens the list while a mention is being typed. */
  const track = (value: string, caret: number) => {
    const match = TYPING.exec(value.slice(0, caret));
    const query = match?.[2] ?? "";
    const start = caret - query.length - 1;
    setTyping(
      match === null || start === dismissed
        ? undefined
        : { start, caret, query, active: 0 },
    );
  };

  const pick = (index: number) => {
    const item = items[index];
    if (typing === undefined || item === undefined) return;
    const name =
      item.id === "agent"
        ? "dx"
        : item.id === "here"
          ? "here"
          : mentionName(item.label);
    // A space follows the name, unless one already does.
    const after = body.slice(typing.caret);
    const spaced = /^\s/u.test(after);
    const text = spaced ? `@${name}` : `@${name} `;
    setBody(body.slice(0, typing.start) + text + after);
    if (item.userId !== undefined)
      setPicked(new Map(picked).set(name, item.userId));
    setTyping(undefined);
    // The caret goes after the space either way.
    const caret = typing.start + text.length + (spaced ? 1 : 0);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(caret, caret);
    });
  };

  /** The list's keys; true when the key was the list's to handle. */
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (typing === undefined) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(typing.start);
      setTyping(undefined);
      return true;
    }
    if (items.length === 0) return false;
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step !== 0) {
      event.preventDefault();
      setTyping({
        ...typing,
        active: (typing.active + step + items.length) % items.length,
      });
      return true;
    }
    if (
      (event.key === "Enter" || event.key === "Tab") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey
    ) {
      event.preventDefault();
      pick(typing.active);
      return true;
    }
    return false;
  };

  const menu =
    typing === undefined ? null : (
      <div className="artifact-comment-suggest">
        <SuggestMenu
          menu={{
            kind: "mention",
            items,
            active: Math.min(typing.active, Math.max(items.length - 1, 0)),
            top: 0,
            left: 0,
            above: true,
            maxHeight: 240,
          }}
          onPick={pick}
          onHighlight={(active) => setTyping({ ...typing, active })}
        />
      </div>
    );

  return {
    menu,
    track,
    onKeyDown,
    post: (draft: string) => withMentions(draft, picked),
    reset: () => {
      setPicked(new Map());
      setDismissed(undefined);
    },
  };
}
