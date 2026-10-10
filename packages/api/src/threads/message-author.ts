/**
 * Who sent a user message. dx prefixes every user message the agent receives
 * with a `<dx_message_author …/>` tag, so the model knows who is speaking in a
 * Thread several people use. Clients read the same tag to label messages.
 *
 * The tag holds only fields that stay the same when a client retries a
 * submission: Flue deduplicates a retry only when its body is identical, so
 * a send time belongs in Flue's message metadata, not here.
 */
export interface MessageAuthor {
  readonly role: "owner" | "contributor";
  readonly userId: string;
  readonly name: string;
  /** Their username: how the agent and others tag them, as `@handle`. */
  readonly handle?: string;
}

/**
 * A workspace member tagged in a message: the `@handle` as it was written,
 * and who it named. Clients show the member's current handle by `userId`, so
 * a later rename updates old messages.
 */
export interface MessageMention {
  readonly handle: string;
  readonly userId: string;
}

/** A user message's tag fields beyond its author. */
export interface MessageAuthorTag {
  readonly author: MessageAuthor;
  /** People talking to each other in a shared Thread; no model call. */
  readonly chat?: boolean;
  readonly mentions?: ReadonlyArray<MessageMention>;
}

/** Tagging the agent sends a message to it, even beside member tags. */
export const AGENT_MENTION = "dx";

const TAG = "dx_message_author";
const leadingTag = new RegExp(`^<${TAG}\\b([^>]*)/>\\n?`);
const anyTag = new RegExp(`</?${TAG}\\b[^>]*>\\n?`, "gi");
const attribute = /([a-z_]+)="([^"]*)"/g;
/** A handle (username) and user id never contain spaces or `=`. */
const mentionPair = /^([^\s=]+)=([^\s=]+)$/;

const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const unescapeAttribute = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

export const formatMessageAuthor = ({
  author,
  chat,
  mentions = [],
}: MessageAuthorTag) =>
  `<${TAG} role="${author.role}" user_id="${escapeAttribute(author.userId)}" identifier="${escapeAttribute(author.name)}"${
    author.handle === undefined
      ? ""
      : ` handle="${escapeAttribute(author.handle)}"`
  }${chat ? ' kind="chat"' : ""}${
    mentions.length === 0
      ? ""
      : ` mentions="${escapeAttribute(mentions.map(({ handle, userId }) => `${handle}=${userId}`).join(" "))}"`
  } />\n`;

/**
 * Removes every author tag from text a person wrote, repeating until none is
 * left so a tag split around another tag cannot reassemble.
 */
export const stripMessageAuthorTags = (text: string) => {
  let current = text;
  for (;;) {
    const next = current.replace(anyTag, "");
    if (next === current) return current;
    current = next;
  }
};

/**
 * The message as the agent receives it: the author tag, then the body with
 * any author tags the sender typed removed so they cannot pose as someone else.
 */
export const withMessageAuthor = (tag: MessageAuthorTag, body: string) =>
  `${formatMessageAuthor(tag)}${stripMessageAuthorTags(body)}`;

/** Splits a leading author tag from a user message. */
export const parseMessageAuthor = (
  text: string,
): {
  readonly author?: MessageAuthor;
  readonly chat?: true;
  readonly mentions?: ReadonlyArray<MessageMention>;
  readonly text: string;
} => {
  const match = leadingTag.exec(text);
  if (match === null) return { text };
  const fields = new Map(
    [...(match[1] ?? "").matchAll(attribute)].map(([, key, value]) => [
      key,
      unescapeAttribute(value ?? ""),
    ]),
  );
  const role = fields.get("role");
  const userId = fields.get("user_id");
  const rest = text.slice(match[0].length);
  if ((role !== "owner" && role !== "contributor") || !userId)
    return { text: rest };
  const mentions = (fields.get("mentions") ?? "")
    .split(" ")
    .flatMap((pair): MessageMention[] => {
      const parsed = mentionPair.exec(pair);
      return parsed === null
        ? []
        : [{ handle: parsed[1] ?? "", userId: parsed[2] ?? "" }];
    });
  return {
    author: {
      role,
      userId,
      name: fields.get("identifier") || "Member",
      ...(fields.get("handle") ? { handle: fields.get("handle") } : {}),
    },
    ...(fields.get("kind") === "chat" ? { chat: true as const } : {}),
    ...(mentions.length === 0 ? {} : { mentions }),
    text: rest,
  };
};

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `@handle` as a standalone word: after a space or the start, before no handle character. */
const mentionPattern = (handle: string, flags = "iu") =>
  new RegExp(`(^|\\s)@${escapeRegExp(handle)}(?![\\p{L}\\p{N}_-])`, flags);

/** Whether `text` tags `handle` (case-insensitive). */
export const mentionsHandle = (text: string, handle: string) =>
  mentionPattern(handle).test(text);

/**
 * Splits text into plain runs and `@handle` mentions of the given handles,
 * in order, each with its offset in `text`, for rendering. Handles match
 * case-insensitively.
 */
export const splitMentions = (
  text: string,
  handles: ReadonlyArray<string>,
): ReadonlyArray<{
  readonly start: number;
  readonly text: string;
  readonly handle?: string;
}> => {
  const known = [...new Set(handles.map((handle) => handle.toLowerCase()))]
    .filter((handle) => handle !== "")
    .sort((left, right) => right.length - left.length);
  if (known.length === 0) return text === "" ? [] : [{ start: 0, text }];
  const pattern = new RegExp(
    `(^|\\s)@(${known.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_-])`,
    "giu",
  );
  const parts: Array<{ start: number; text: string; handle?: string }> = [];
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const handle = match[2] ?? "";
    if (start > index)
      parts.push({ start: index, text: text.slice(index, start) });
    parts.push({ start, text: `@${handle}`, handle: handle.toLowerCase() });
    index = start + 1 + handle.length;
  }
  if (index < text.length)
    parts.push({ start: index, text: text.slice(index) });
  return parts;
};
