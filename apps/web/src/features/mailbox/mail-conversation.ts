import type { MailConversation, MailMessage } from "@dx/api";

/** Every label on a conversation's emails, once each. */
export const conversationLabels = (messages: ReadonlyArray<MailMessage>) => {
  const byId = new Map<string, MailMessage["labels"][number]>();
  for (const message of messages)
    for (const label of message.labels) byId.set(label.id, label);
  return [...byId.values()];
};

/**
 * A reply's own words and the email it quotes: from an "On …, … wrote:"
 * line, or a run of `>` lines, to the end.
 */
export const splitQuote = (text: string) => {
  const lines = text.replace(/\s+$/, "").split("\n");
  const quoted = (line: string) => line.startsWith(">") || line.trim() === "";
  let start = lines.length;
  while (start > 0 && quoted(lines[start - 1] as string)) start -= 1;
  if (start > 0 && /^On .+wrote:\s*$/.test(lines[start - 1] as string))
    start -= 1;
  if (
    start >= lines.length ||
    !lines.slice(start).some((l) => l.startsWith(">"))
  )
    return { body: text, quote: undefined };
  return {
    body: lines.slice(0, start).join("\n").replace(/\s+$/, ""),
    quote: lines.slice(start).join("\n"),
  };
};

/** The newest email: what Reply, Reply all, and Forward answer. */
export const latestMessage = (conversation: MailConversation) =>
  conversation.messages.at(-1);

/** Where the conversation sits: Spam, Archive, or else the Inbox. */
export const conversationFolder = (conversation: MailConversation) => {
  const received = conversation.messages.filter(
    (message) => message.direction === "in",
  );
  if (received.some((message) => message.folder === "spam")) return "spam";
  const latest = (received.at(-1) ?? conversation.messages.at(-1))?.folder;
  return latest === "archive"
    ? "archive"
    : latest === "sent"
      ? "sent"
      : "inbox";
};
