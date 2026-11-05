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
