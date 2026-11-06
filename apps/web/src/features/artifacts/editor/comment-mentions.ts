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
 * A draft as it posts: `@dx` becomes dx's mention, `@here` the mention
 * everyone is notified by, and each picked person's `@Name` their mention.
 * A name edited after it was picked no longer matches, so it stays text.
 */
export const withMentions = (draft: string, picked: PickedPeople) => {
  let posted = withAgentMention(draft).replace(
    typed("here"),
    `$1${HERE_MENTION}`,
  );
  // Longest first, so "Maya Member" is not taken for "Maya".
  for (const [name, userId] of Array.from(picked).toSorted(
    ([a], [b]) => b.length - a.length,
  ))
    posted = posted.replace(typed(name), `$1@[${name}](user:${userId})`);
  return posted;
};
