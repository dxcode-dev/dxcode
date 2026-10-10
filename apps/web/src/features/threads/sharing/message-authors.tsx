import { Popover } from "@base-ui/react/popover";
import {
  AGENT_MENTION,
  type MessageAuthor,
  type MessageMention,
  splitMentions,
  type ThreadDetailData,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Avatar } from "../../../shared/ui/avatar.js";
import {
  MarkdownMentionContext,
  type MarkdownMentions,
} from "../../../shared/ui/markdown-mention-context.js";
import { conciseAge } from "./sharing-format.js";
import { threadMembersQueryOptions } from "./thread-chat-queries.js";
import "./thread-sharing.css";

/** How dx shows a person: their current name, handle, and picture. */
interface Person {
  readonly userId: string;
  readonly name: string;
  readonly handle?: string;
  readonly email?: string;
  readonly image?: string;
}

interface MessageAuthorsValue {
  readonly viewerId: string;
  readonly ownerId?: string;
  readonly people: ReadonlyMap<string, Person>;
}

const MessageAuthorsContext = React.createContext<
  MessageAuthorsValue | undefined
>(undefined);

/**
 * Labels user messages with their sender once more than one person uses a
 * Thread (it is shared, or someone else has written in it), and shows the
 * current name and handle of everyone a message names. Members come from the
 * shared workspace; participants cover people who wrote while it was shared.
 */
export function MessageAuthorsProvider({
  thread,
  viewerId,
  children,
}: {
  readonly thread: Pick<ThreadDetailData, "id" | "participants" | "sharing">;
  readonly viewerId: UserId;
  readonly children: React.ReactNode;
}) {
  const { participants, sharing } = thread;
  const multiplayer =
    participants !== undefined &&
    (participants.length > 1 || sharing !== undefined);
  const membersQuery = useQuery({
    ...threadMembersQueryOptions(viewerId, thread.id),
    enabled: sharing !== undefined,
  });
  const members = membersQuery.data;
  const value = React.useMemo<MessageAuthorsValue | undefined>(() => {
    if (!multiplayer) return undefined;
    const people = new Map<string, Person>(
      participants.map((person) => [person.userId, person]),
    );
    for (const member of members ?? []) people.set(member.userId, member);
    return {
      viewerId,
      ownerId: participants.find((person) => person.owner)?.userId,
      people,
    };
  }, [multiplayer, participants, members, viewerId]);
  return (
    <MessageAuthorsContext value={value}>{children}</MessageAuthorsContext>
  );
}

export interface ResolvedMessageAuthor extends Person {
  readonly sentAt?: string;
  readonly mine: boolean;
}

/**
 * The sender of a user message: its author tag, else the viewer for a message
 * not yet admitted (a local echo), else the owner (sent before tags).
 */
export const useMessageAuthor = (
  author: MessageAuthor | undefined,
  admitted: boolean,
  sentAt?: string,
): ResolvedMessageAuthor | undefined => {
  const context = React.use(MessageAuthorsContext);
  if (context === undefined) return undefined;
  const userId =
    author?.userId ??
    (admitted ? context.ownerId : context.viewerId) ??
    context.viewerId;
  const person = context.people.get(userId);
  return {
    userId,
    name: person?.name ?? author?.name ?? "Member",
    ...(person?.handle === undefined ? {} : { handle: person.handle }),
    ...(person?.email === undefined ? {} : { email: person.email }),
    ...(person?.image === undefined ? {} : { image: person.image }),
    ...(sentAt === undefined ? {} : { sentAt }),
    mine: userId === context.viewerId,
  };
};

/** Avatar, name ("You" for the viewer), and send time of a message. */
export function MessageAuthorLabel({
  author,
}: {
  readonly author: ResolvedMessageAuthor;
}) {
  return (
    <div className="message-author">
      <MemberCard person={author}>
        <Avatar name={author.name} image={author.image} seed={author.userId} />
        <span className="message-author-name">
          {author.mine ? "You" : author.name}
        </span>
      </MemberCard>
      {author.sentAt === undefined ? null : (
        <time
          dateTime={author.sentAt}
          title={new Date(author.sentAt).toLocaleString()}
        >
          {conciseAge(author.sentAt)}
        </time>
      )}
    </div>
  );
}

/** A person's card: picture, name, handle, and email. */
function MemberCard({
  person,
  className,
  children,
}: {
  readonly person: Person;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger className={className ?? "message-author-trigger"}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          className="member-card-positioner"
          side="top"
          align="start"
          sideOffset={6}
        >
          <Popover.Popup className="member-card">
            <Avatar
              name={person.name}
              image={person.image}
              seed={person.userId}
            />
            <div>
              <strong>{person.name}</strong>
              {person.handle === undefined ? null : (
                <span>@{person.handle}</span>
              )}
              {person.email === undefined ? null : <span>{person.email}</span>}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * What a person wrote, as plain text: never Markdown. Each `@handle` it
 * tagged shows the member's current handle (or name, without one) and opens
 * their card; `@dx` shows as the agent.
 */
export function UserMessageText({
  text,
  mentions,
}: {
  readonly text: string;
  readonly mentions?: ReadonlyArray<MessageMention>;
}) {
  const context = React.use(MessageAuthorsContext);
  const byHandle = new Map(
    (mentions ?? []).map((mention) => [
      mention.handle.toLowerCase(),
      mention.userId,
    ]),
  );
  const parts = splitMentions(text, [...byHandle.keys(), AGENT_MENTION]);
  return (
    <p className="user-message-text">
      {parts.map((part) => {
        if (part.handle === undefined) return part.text;
        const key = part.start;
        if (part.handle === AGENT_MENTION && !byHandle.has(part.handle))
          return (
            <span key={key} className="message-mention" data-agent="">
              @{AGENT_MENTION}
            </span>
          );
        const userId = byHandle.get(part.handle) ?? "";
        const person = context?.people.get(userId);
        if (person === undefined)
          return (
            <span key={key} className="message-mention">
              {part.text}
            </span>
          );
        return (
          <MemberCard key={key} person={person} className="message-mention">
            @{person.handle ?? person.name}
          </MemberCard>
        );
      })}
    </p>
  );
}

/**
 * The agent tags people the way they do, as `@handle`: in a Thread more than
 * one person uses, its replies show those tags as pills too.
 */
export function AgentMentions({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const context = React.use(MessageAuthorsContext);
  const people = context?.people;
  const mentions = React.useMemo((): MarkdownMentions | undefined => {
    if (people === undefined) return undefined;
    const byHandle = new Map(
      [...people.values()].flatMap((person) =>
        person.handle === undefined
          ? []
          : [[person.handle.toLowerCase(), person] as const],
      ),
    );
    return {
      handles: [...byHandle.keys()],
      render: (handle, text) => {
        const person = byHandle.get(handle);
        return person === undefined ? (
          text
        ) : (
          <MemberCard person={person} className="message-mention">
            @{person.handle ?? person.name}
          </MemberCard>
        );
      },
    };
  }, [people]);
  return mentions === undefined ? (
    children
  ) : (
    <MarkdownMentionContext value={mentions}>{children}</MarkdownMentionContext>
  );
}
