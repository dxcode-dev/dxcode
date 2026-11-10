import type { ThreadMemberData } from "@dx/api";

/**
 * Whom `@` lists in an artifact's body and in comments, artifact comments
 * and a Space's message comments alike: dx, then the Thread's people.
 */

/** Whether `query` starts any word of `text`, ignoring case. */
export const startsAWord = (text: string, query: string) =>
  text
    .toLowerCase()
    .split(/[\s_-]+/)
    .some((word) => word.startsWith(query));

export interface PersonItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** Absent for the agent. */
  readonly userId?: string;
  readonly image?: string;
}

/**
 * Whom `@query` can mention: dx, then the Thread's people (its owner and its
 * members while it is shared) other than you, by name or username.
 */
export const peopleItems = (
  query: string,
  members: ReadonlyArray<ThreadMemberData>,
  viewerId: string,
): ReadonlyArray<PersonItem> => {
  const wanted = query.toLowerCase();
  const agent: PersonItem = { id: "agent", label: "dx", hint: "the agent" };
  return [
    ...(startsAWord("dx agent", wanted) ? [agent] : []),
    ...members.flatMap((member) =>
      member.userId !== viewerId &&
      (startsAWord(member.name, wanted) ||
        member.handle.toLowerCase().startsWith(wanted))
        ? [
            {
              id: member.userId,
              label: member.name,
              hint: `@${member.handle}`,
              userId: member.userId,
              ...(member.image === undefined ? {} : { image: member.image }),
            },
          ]
        : [],
    ),
  ].slice(0, 8);
};

/** `@here`: everyone who can open the Thread. */
const HERE_ITEM: PersonItem = {
  id: "here",
  label: "here",
  hint: "Notify everyone in this Thread",
};

/**
 * Whom `@query` in a comment can mention: the body's people (dx, then the
 * Thread's people other than you), then `@here`.
 */
export const commentPeopleItems = (
  query: string,
  members: ReadonlyArray<ThreadMemberData>,
  viewerId: string,
): ReadonlyArray<PersonItem> => [
  ...peopleItems(query, members, viewerId),
  ...(startsAWord("here everyone", query.toLowerCase()) ? [HERE_ITEM] : []),
];
