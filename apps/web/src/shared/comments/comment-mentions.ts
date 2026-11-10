/**
 * The comment box shows `@dx` as people read it and posts the mention dx
 * wakes on (`@[dx](agent)`).
 */

/** `@dx` typed as people read it: a word of its own, not part of a name or address. */
const TYPED_AGENT = /(^|[\s([{])@dx(?![\w.@-]*\w)/g;
/** The agent's mention as artifacts write it. */
const AGENT_MENTION = "@[dx](agent)";

/** Whether a draft asks dx, typed or as a mention. */
export const asksAgent = (draft: string) =>
  draft.includes(AGENT_MENTION) || new RegExp(TYPED_AGENT.source).test(draft);

/** A draft as it posts: a typed `@dx` becomes the mention dx wakes on. */
export const withAgentMention = (draft: string) =>
  draft.replace(TYPED_AGENT, `$1${AGENT_MENTION}`);

/** Ask @dx: adds `@dx` to the start of a draft, or takes it back out. */
export const toggleAgent = (draft: string) =>
  asksAgent(draft)
    ? draft
        .replaceAll(`${AGENT_MENTION} `, "")
        .replaceAll(AGENT_MENTION, "")
        .replace(TYPED_AGENT, "$1")
        .replace(/^\s+/, "")
    : `@dx ${draft}`;

/** Everyone who can open the Thread, as artifacts write it. */
export const HERE_MENTION = "@[here](here)";

/** People picked from the `@` list, by the name the box shows for them. */
export type PickedPeople = ReadonlyMap<string, string>;

/** A name as a mention can hold it, and as the box shows it. */
export const mentionName = (name: string) =>
  name
    .replace(/[[\]()\n\r]/g, " ")
    .trim()
    .slice(0, 60) || "Member";

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `@word` typed as people read it, a word of its own. */
const typed = (word: string) =>
  new RegExp(`(^|[\\s([{])@${escaped(word)}(?![\\w.@-]*\\w)`, "g");

/**
 * A draft as it posts: each picked person's `@Name` becomes their mention,
 * then `@dx` dx's mention and `@here` the mention everyone is notified by.
 * People come first, so a picked name that starts with "dx" stays that
 * person and never wakes dx. A name edited after it was picked no longer
 * matches, so it stays text.
 */
export const withMentions = (draft: string, picked: PickedPeople) => {
  let posted = draft;
  // Longest first, so "Maya Member" is not taken for "Maya".
  for (const [name, userId] of Array.from(picked).toSorted(
    ([a], [b]) => b.length - a.length,
  ))
    posted = posted.replace(typed(name), `$1@[${name}](user:${userId})`);
  return withAgentMention(posted).replace(typed("here"), `$1${HERE_MENTION}`);
};

/** A mention as `withMentions` writes it. */
const POSTED_MENTION =
  /@\[([^\]\n]+)\]\((?:user:([A-Za-z0-9_-]+)|agent|here)\)/g;

/**
 * A posted text back as people read and edit it: each mention as `@Name`,
 * `@dx`, or `@here`, with the people picked in it, so posting the edited
 * draft (`withMentions`) writes the same mentions again.
 */
export const draftOf = (posted: string) => {
  const picked = new Map<string, string>();
  const draft = posted.replace(
    POSTED_MENTION,
    (_match, name: string, userId: string | undefined) => {
      if (userId !== undefined) picked.set(name, userId);
      return `@${name}`;
    },
  );
  return { draft, picked: picked as PickedPeople };
};
