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
  /**
   * The owner's Thread whose agent sent this message with a Thread tool.
   * Only the server sets it; clients show the message as from that Thread.
   */
  readonly sourceThreadId?: string;
  /**
   * dx's name for the message, set when it tags someone, so a notification
   * can open the Thread at it. Only the server sets it, from the delivery's
   * idempotency key, so a retry carries the same tag.
   */
  readonly messageId?: string;
  /**
   * What delivered this message on the owner's behalf after a turn ended:
   * the Thread's schedule, a GitHub subscription, a person ticking or
   * answering an ask in one of its artifacts, or text from outside dx (a
   * feedback widget or a plugin's webhook). Only the server sets it.
   */
  readonly automation?: MessageAutomation;
  /**
   * The Flue message a person commented on, when this message is their
   * comment that mentions dx (a Space's message comments). Only the server
   * sets it; clients show the message compactly, since the comment stays in
   * the message's comments.
   */
  readonly commentOn?: string;
  /**
   * The person edited an earlier message into this one: the turns after the
   * original were removed from the conversation, and what they changed in
   * files, artifacts, and other Threads stays. Only the server sets it.
   */
  readonly edited?: boolean;
  /**
   * The installed plugin whose code posted this message on the owner's
   * behalf with `ctx.thread.append` or `note`. Only the server sets it;
   * clients show the message as the plugin's, not the person's.
   */
  readonly plugin?: MessagePlugin;
}

/** The plugin that posted a message, as its tag records it. */
export interface MessagePlugin {
  /** The install's id. */
  readonly id: string;
  /** Its display name when it posted. */
  readonly name: string;
  /** Who installed it: the owner, their workspace, or the repository. */
  readonly scope: "personal" | "workspace" | "repository";
  /**
   * The sha256 of the icon of the version that posted it, served at
   * `/v1/plugins/icons/<hash>`, so old messages keep their icon.
   */
  readonly iconHash?: string;
}

/** Senders that wake a Thread on the owner's behalf. */
/**
 * `external`: text from outside dx started the Thread, such as a website's
 * feedback widget or a plugin's webhook trigger.
 */
export type MessageAutomation =
  | "schedule"
  | "github"
  | "artifact"
  | "settings"
  | "external";

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
  sourceThreadId,
  messageId,
  automation,
  commentOn,
  edited,
  plugin,
}: MessageAuthorTag) =>
  `<${TAG} role="${author.role}" user_id="${escapeAttribute(author.userId)}" identifier="${escapeAttribute(author.name)}"${
    author.handle === undefined
      ? ""
      : ` handle="${escapeAttribute(author.handle)}"`
  }${chat ? ' kind="chat"' : ""}${
    mentions.length === 0
      ? ""
      : ` mentions="${escapeAttribute(mentions.map(({ handle, userId }) => `${handle}=${userId}`).join(" "))}"`
  }${
    sourceThreadId === undefined
      ? ""
      : ` source_thread="${escapeAttribute(sourceThreadId)}"`
  }${
    messageId === undefined ? "" : ` message_id="${escapeAttribute(messageId)}"`
  }${automation === undefined ? "" : ` automation="${automation}"`}${
    commentOn === undefined ? "" : ` comment_on="${escapeAttribute(commentOn)}"`
  }${edited === true ? ' edited="true"' : ""}${
    plugin === undefined
      ? ""
      : ` plugin="${escapeAttribute(plugin.name)}" plugin_id="${escapeAttribute(plugin.id)}" plugin_scope="${plugin.scope}"${
          plugin.iconHash !== undefined &&
          /^[0-9a-f]{64}$/.test(plugin.iconHash)
            ? ` plugin_icon="${plugin.iconHash}"`
            : ""
        }`
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

const pluginOf = (
  fields: ReadonlyMap<string, string>,
): MessagePlugin | undefined => {
  const id = fields.get("plugin_id");
  const name = fields.get("plugin");
  const scope = fields.get("plugin_scope");
  const iconHash = fields.get("plugin_icon");
  return id &&
    name &&
    (scope === "personal" || scope === "workspace" || scope === "repository")
    ? {
        id,
        name,
        scope,
        ...(iconHash !== undefined && /^[0-9a-f]{64}$/.test(iconHash)
          ? { iconHash }
          : {}),
      }
    : undefined;
};

/** Splits a leading author tag from a user message. */
export const parseMessageAuthor = (
  text: string,
): {
  readonly author?: MessageAuthor;
  readonly chat?: true;
  readonly mentions?: ReadonlyArray<MessageMention>;
  readonly sourceThreadId?: string;
  readonly messageId?: string;
  readonly automation?: MessageAutomation;
  readonly commentOn?: string;
  readonly edited?: true;
  readonly plugin?: MessagePlugin;
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
    ...(fields.get("source_thread")
      ? { sourceThreadId: fields.get("source_thread") }
      : {}),
    ...(fields.get("message_id")
      ? { messageId: fields.get("message_id") }
      : {}),
    ...(fields.get("automation") === "schedule" ||
    fields.get("automation") === "github" ||
    fields.get("automation") === "artifact" ||
    fields.get("automation") === "settings" ||
    fields.get("automation") === "external"
      ? { automation: fields.get("automation") as MessageAutomation }
      : {}),
    ...(fields.get("comment_on")
      ? { commentOn: fields.get("comment_on") }
      : {}),
    ...(fields.get("edited") === "true" ? { edited: true as const } : {}),
    ...(pluginOf(fields) === undefined ? {} : { plugin: pluginOf(fields) }),
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
