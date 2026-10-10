import {
  AGENT_MENTION,
  mentionsHandle,
  type ThreadConversationMode,
  type ThreadMemberData,
} from "@dx/api";

/**
 * The mode a message would be sent in (the server decides the same way):
 * `@dx` goes to the agent, tagging someone else is chat, and an untagged
 * message keeps the Thread's current mode.
 */
export const draftMode = (
  draft: string,
  members: ReadonlyArray<ThreadMemberData>,
  viewerId: string,
  current: ThreadConversationMode,
): ThreadConversationMode =>
  mentionsHandle(draft, AGENT_MENTION)
    ? "agent"
    : members.some(
          (member) =>
            member.userId !== viewerId && mentionsHandle(draft, member.handle),
        )
      ? "chat"
      : current;

/** The `@` word the caret is in, if any: where it starts and what follows. */
export const activeMention = (
  draft: string,
  caret: number,
): { readonly start: number; readonly query: string } | undefined => {
  const before = draft.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/u.exec(before);
  if (match === null) return undefined;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query };
};

export type MentionOption =
  | { readonly kind: "agent"; readonly handle: string }
  | {
      readonly kind: "member";
      readonly handle: string;
      readonly member: ThreadMemberData;
    };

/**
 * Options for the `@` word being typed: the agent, then other members whose
 * handle or name starts a word with the query. Tagging yourself means nothing.
 */
export const mentionOptions = (
  query: string,
  members: ReadonlyArray<ThreadMemberData>,
  viewerId: string,
): ReadonlyArray<MentionOption> => {
  const wanted = query.toLowerCase();
  const matches = (text: string) =>
    text
      .toLowerCase()
      .split(/[\s_-]+/)
      .some((word) => word.startsWith(wanted)) ||
    text.toLowerCase().startsWith(wanted);
  return [
    ...(AGENT_MENTION.startsWith(wanted)
      ? [{ kind: "agent" as const, handle: AGENT_MENTION }]
      : []),
    ...members.flatMap((member) =>
      member.userId !== viewerId &&
      (matches(member.handle) || matches(member.name))
        ? [{ kind: "member" as const, handle: member.handle, member }]
        : [],
    ),
  ].slice(0, 8);
};
